// routes/loyalty.js
// Customer-facing stamp card (automatic enrolment, earn stamps, self-serve
// redeem).
//
// There is no loyalty signup step. Having a ReceipTap account IS the opt-in:
// the first receipt a shopper links to their account from a merchant running
// an active program starts their card at one punch, and every receipt after
// that adds another (see awardLoyaltyStamps, called from every place a
// transaction gets linked to an account) -> once at 5, the customer taps
// "Redeem", types in the merchant's redemption code -> if it matches, the
// reward is granted immediately and the card resets for the next cycle.
//
// Progress lives in the customer's wallet under More -> My Rewards
// (/account/loyalty).

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { splitLoyaltyCards } = require('../lib/loyaltyCardSections');
const fileStorage = require('../lib/fileStorage');
const normalizeEmail = require('../lib/normalizeEmail');
const { notifyLoyaltyCardFull } = require('../services/notificationService');
const { notifyMerchantLoyaltyCardFilled } = require('../services/merchantNotificationService');

function requireCustomerAuth(req, res, next) {
  if (!req.session?.customerId) return res.status(401).json({ error: 'Not signed in' });
  next();
}

// How many stamps one receipt is worth under the merchant's chosen rule.
// Returns 0 when a receipt earns nothing -- a second visit on a VISIT day, or
// an ITEM rule whose product wasn't on this receipt. `card` is null when this
// is the customer's first receipt from this merchant.
function stampsEarnedFor(program, transaction, card) {
  switch (program.earnRule) {
    case 'VISIT': {
      // One stamp a day however many receipts they save. Day boundaries are
      // UTC -- nothing on Merchant records a timezone, and the alternative
      // (server-local) would shift under a deploy to a different region.
      if (!card || !card.lastStampedAt) return 1;
      return sameUtcDay(card.lastStampedAt, new Date()) ? 0 : 1;
    }

    case 'ITEM': {
      const needle = (program.earnItemName || '').trim().toLowerCase();
      if (!needle) return 0; // rule chosen but no product named yet -- nothing can match
      const items = Array.isArray(transaction.lineItems) ? transaction.lineItems : [];
      return items.reduce((total, item) => {
        const name = typeof item?.name === 'string' ? item.name.toLowerCase() : '';
        if (!name.includes(needle)) return total;
        // Two coffees on one receipt are two stamps. Quantity is whatever the
        // POS sent, so treat anything unusable as a single unit.
        const quantity = Math.floor(Number(item?.quantity));
        return total + (Number.isFinite(quantity) && quantity > 0 ? quantity : 1);
      }, 0);
    }

    case 'AMOUNT': {
      if (!program.earnAmountCents || program.earnAmountCents <= 0) return 0;
      return Math.floor(transaction.total / program.earnAmountCents);
    }

    case 'ORDER':
    default:
      return 1;
  }
}

function sameUtcDay(a, b) {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

// Called after any transaction gets linked to a customer's account (saving a
// receipt to the wallet, email capture, Google sign-in, a POS webhook
// recognising a returning shopper). Starts the card if this is their first
// receipt from this merchant, otherwise adds whatever the receipt earned.
// Exported so every linking path can call it without duplicating this logic.
async function awardLoyaltyStamps(transaction, customerId) {
  // Only merchants actively running a program stamp cards. Checked here
  // rather than at each call site so no caller can forget it.
  const program = await prisma.loyaltyProgram.findUnique({ where: { merchantId: transaction.merchantId } });
  if (!program || !program.enabled) return;

  const where = { merchantId_customerId: { merchantId: transaction.merchantId, customerId } };
  const card = await prisma.loyaltyCard.findUnique({ where });

  if (card && card.stamps >= program.stampsRequired) return; // full, waiting to be redeemed

  const earned = stampsEarnedFor(program, transaction, card);
  if (earned <= 0) return;

  const now = new Date();

  if (!card) {
    // First linked receipt from this merchant -- enrol them automatically,
    // starting from the head-start bonus. upsert, not create: two receipts
    // linking at the same moment would otherwise collide on the unique index,
    // and the second should be a no-op rather than a crash or a double stamp.
    const created = await prisma.loyaltyCard.upsert({
      where,
      create: {
        merchantId: transaction.merchantId,
        customerId,
        stamps: Math.min(program.headStartStamps + earned, program.stampsRequired),
        lastStampedAt: now,
      },
      update: {},
    });
    // A generous head start on a short card can fill it on the first receipt.
    await notifyIfJustFilled(created.stamps, program, transaction.merchantId, customerId);
    return;
  }

  const updated = await prisma.loyaltyCard.update({
    where: { id: card.id },
    // Clamped: an AMOUNT or ITEM receipt can be worth more stamps than the
    // card has room for, and a card never goes past full.
    data: { stamps: Math.min(card.stamps + earned, program.stampsRequired), lastStampedAt: now },
  });
  await notifyIfJustFilled(updated.stamps, program, transaction.merchantId, customerId);
}

// Fires once, on the receipt that takes a card to full. Everything above
// returns early on an already-full card, so this can't fire twice for the same
// reward -- and a card that's redeemed and filled again does notify again,
// because that's a second reward.
//
// Wrapped: a notification that fails to send must never roll back the stamp
// the customer just earned, or fail the request that linked the receipt.
async function notifyIfJustFilled(stamps, program, merchantId, customerId) {
  if (stamps < program.stampsRequired) return;
  try {
    await notifyLoyaltyCardFull({ merchantId, customerId, program });
  } catch (err) {
    console.error('[loyalty] card-full notification failed:', err.message);
  }
  // Separate try/catch on purpose: a failure notifying the merchant must
  // never be blamed on, or block, the customer's own notification above.
  try {
    await notifyMerchantLoyaltyCardFilled({ merchantId, customerId, program });
  } catch (err) {
    console.error('[loyalty] merchant card-full notification failed:', err.message);
  }
}

// --- Customer: redeem a full card by entering the merchant's code -----------
router.post('/loyalty/:cardId/redeem', requireCustomerAuth, async (req, res) => {
  const { code } = req.body;
  const card = await prisma.loyaltyCard.findUnique({ where: { id: req.params.cardId } });
  if (!card || card.customerId !== req.session.customerId) return res.status(404).json({ error: 'Not found' });
  const program = await prisma.loyaltyProgram.findUnique({ where: { merchantId: card.merchantId } });
  if (!program) return res.status(404).json({ error: 'Not found' });
  if (card.stamps < program.stampsRequired) return res.status(400).json({ error: 'Card is not full yet' });

  const submitted = (code || '').trim().toLowerCase();
  if (!submitted || submitted !== program.redemptionCode.trim().toLowerCase()) {
    return res.status(400).json({ error: 'Incorrect code -- check with your cashier and try again.' });
  }

  await prisma.loyaltyCard.update({
    where: { id: card.id },
    data: { stamps: 0, lastRedeemedAt: new Date() },
  });

  res.json({ success: true });
});

// --- Customer dashboard: every loyalty card across every merchant -----------
router.get('/account/loyalty', async (req, res) => {
  if (!req.session?.customerId) {
    return res.redirect(`/account/login?redirect=${encodeURIComponent('/account/loyalty')}`);
  }

  const [customer, cards] = await Promise.all([
    prisma.customer.findUnique({ where: { id: req.session.customerId } }),
    prisma.loyaltyCard.findMany({
      where: { customerId: req.session.customerId },
      include: { merchant: { include: { loyaltyProgram: true, receiptTheme: true } } },
      orderBy: { updatedAt: 'desc' },
    }),
  ]);

  const visibleCards = cards
      .filter((c) => c.merchant.loyaltyProgram) // hide cards for a merchant that has since removed their program entirely
      .map((c) => {
        const program = c.merchant.loyaltyProgram;
        // Same resolver the merchant's own preview uses, so what they designed
        // is what lands here -- including the receipt-logo and monogram
        // fallbacks for a merchant who never opened Card design.
        const design = resolveCardDesign(program, c.merchant.receiptTheme, c.merchant);
        return {
          id: c.id,
          merchantName: design.businessName,
          stamps: c.stamps,
          stampsRequired: program.stampsRequired,
          rewardLabel: program.rewardLabel,
          design,
        };
      });

  // Redeemable cards first -- see lib/loyaltyCardSections.js for why.
  const { ready, inProgress } = splitLoyaltyCards(visibleCards);

  res.render('account-loyalty', {
    customerEmail: customer?.email || '',
    // Kept for the "no cards at all" empty state, which is a different message
    // from "no cards match that search".
    cards: visibleCards,
    readyCards: ready,
    inProgressCards: inProgress,
  });
});


// ---------------------------------------------------------------------------
// Merchant side -- everything behind /account/business/loyalty. The routes
// themselves live in routes/account-business.js with the rest of the wallet's
// Business section; only the data lives here, beside the rules it configures.
// ---------------------------------------------------------------------------

const EARN_RULES = ['ORDER', 'VISIT', 'ITEM', 'AMOUNT'];

const DEFAULT_PROGRAM = {
  enabled: false,
  earnRule: 'ORDER',
  earnItemName: '',
  earnAmountCents: 1000,
  stampsRequired: 10,
  rewardLabel: 'Free reward',
  headStartStamps: 0,
  cardLogoUrl: '',
  cardBackground: '#0A84FF',
  cardAccent: '#FFFFFF',
  redemptionCode: 'REWARD',
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// Text drawn on top of the card background. Merchants pick their own accent,
// but the DEFAULT has to be readable against whatever background they chose --
// white on a navy card, near-black on a pale yellow one. Standard relative
// luminance, same threshold browsers use for prefers-contrast heuristics.
function readableInkFor(background) {
  const hex = (background || '').replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  if (full.length !== 6) return '#FFFFFF';

  const channel = (pair) => {
    const v = parseInt(pair, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * channel(full.slice(0, 2)) + 0.7152 * channel(full.slice(2, 4)) + 0.0722 * channel(full.slice(4, 6));

  return luminance > 0.45 ? '#111111' : '#FFFFFF';
}

// What the stamp card actually looks like, wherever it's drawn -- the merchant's
// preview and the customer's wallet both go through here so they can't disagree.
//
// The logo is resolved live rather than copied into cardLogoUrl on save: a
// merchant who never opens Card design still gets their receipt logo on the
// card, and one who later changes that logo sees it follow. Only an explicit
// upload here overrides it. With no logo anywhere, a monogram beats the generic
// storefront glyph -- it at least looks chosen.
function resolveCardDesign(program, theme, merchant) {
  const name = (theme && theme.displayName) || (merchant && merchant.businessName) || '';
  return {
    background: program.cardBackground || DEFAULT_PROGRAM.cardBackground,
    accent: program.cardAccent || DEFAULT_PROGRAM.cardAccent,
    logoUrl: program.cardLogoUrl || (theme && theme.logoUrl) || null,
    logoIsInherited: !program.cardLogoUrl && Boolean(theme && theme.logoUrl),
    monogram: name.trim().charAt(0).toUpperCase() || '★',
    businessName: name.trim() || 'Your business',
  };
}

// A colour goes straight into a style attribute on the wallet card, so only
// accept a literal hex triple/sextet -- never whatever was posted.
function safeHexColor(value, fallback) {
  return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test((value || '').trim()) ? value.trim() : fallback;
}

// One line describing the active rule, shown under the business name on the
// card preview and on the wallet card itself.
function describeEarnRule(program) {
  switch (program.earnRule) {
    case 'VISIT':
      return '1 stamp per visit (once a day)';
    case 'ITEM':
      return program.earnItemName ? `1 stamp per ${program.earnItemName}` : '1 stamp per matching item';
    case 'AMOUNT':
      return `1 stamp per $${(program.earnAmountCents / 100).toFixed(2)} spent`;
    case 'ORDER':
    default:
      return '1 stamp per order';
  }
}

async function computeLoyaltyPageData(merchantId) {
  const [merchant, saved, theme, memberCount] = await Promise.all([
    prisma.merchant.findUnique({ where: { id: merchantId } }),
    prisma.loyaltyProgram.findUnique({ where: { merchantId } }),
    prisma.receiptTheme.findUnique({ where: { merchantId } }),
    prisma.loyaltyCard.count({ where: { merchantId } }),
  ]);

  const program = { ...DEFAULT_PROGRAM, ...(saved || {}) };

  // A merchant opening this page for the first time has no program row yet, so
  // rather than showing them a stock blue card, start from the branding they
  // already picked on Receipt design. These are just the form's initial values
  // -- the first save writes them, and after that this page is the only thing
  // that changes them.
  if (!saved && theme && theme.accentColor) {
    program.cardBackground = theme.accentColor;
    program.cardAccent = readableInkFor(theme.accentColor);
  }
  // earnAmountCents is stored in cents like every other money column, but the
  // merchant types dollars.
  program.earnAmountDollars = (program.earnAmountCents / 100).toFixed(2);
  program.earnItemName = program.earnItemName || '';
  program.cardLogoUrl = program.cardLogoUrl || '';

  return {
    merchant,
    program,
    card: resolveCardDesign(program, theme, merchant),
    earnRuleText: describeEarnRule(program),
    memberCount,
    saved: false,
    error: null,
    redeemMessage: null,
    redeemError: null,
  };
}

async function saveLoyaltyProgram(merchantId, body, file) {
  const earnRule = EARN_RULES.includes(body.earnRule) ? body.earnRule : 'ORDER';
  const stampsRequired = clamp(parseInt(body.stampsRequired, 10) || 10, 1, 50);

  const data = {
    enabled: body.enabled === 'on' || body.enabled === 'true',
    earnRule,
    earnItemName: earnRule === 'ITEM' ? (body.earnItemName || '').trim().slice(0, 60) || null : null,
    earnAmountCents: Math.max(1, Math.round(parseFloat(body.earnAmountDollars) * 100) || 1000),
    stampsRequired,
    rewardLabel: (body.rewardLabel || '').trim().slice(0, 60) || 'Free reward',
    // A head start that reaches the target would hand every new customer a
    // full card on their first receipt -- cap it one short.
    headStartStamps: clamp(parseInt(body.headStartStamps, 10) || 0, 0, Math.max(0, stampsRequired - 1)),
    cardBackground: safeHexColor(body.cardBackground, DEFAULT_PROGRAM.cardBackground),
    cardAccent: safeHexColor(body.cardAccent, DEFAULT_PROGRAM.cardAccent),
    redemptionCode: (body.redemptionCode || '').trim().slice(0, 40) || 'REWARD',
  };
  // Same multer handler the receipt logo uses -- only overwrite the stored
  // path when this submit actually carried a new file.
  // Reuses theme-settings' logo upload, which is memory-backed now, so this
  // has to store the buffer rather than reference a filename on disk.
  if (file) data.cardLogoUrl = await fileStorage.putPublic('logos', file, { prefix: merchantId });

  await prisma.loyaltyProgram.upsert({ where: { merchantId }, create: { merchantId, ...data }, update: data });

  return { ...(await computeLoyaltyPageData(merchantId)), saved: true };
}

// Staff redeeming on a customer's behalf at the counter. The code is the same
// shared one the customer would type on their own phone; the email is what
// says whose card to clear, since one shared code can't identify a card.
async function redeemForCustomer(merchantId, rawEmail, rawCode) {
  const email = normalizeEmail(rawEmail || '');
  const code = (rawCode || '').trim().toLowerCase();
  if (!email || !code) return { error: 'Enter the customer\'s email and your redemption code.' };

  const program = await prisma.loyaltyProgram.findUnique({ where: { merchantId } });
  if (!program) return { error: 'Set up your stamp card before redeeming.' };
  if (code !== program.redemptionCode.trim().toLowerCase()) return { error: 'That code doesn\'t match your redemption code.' };

  const customer = await prisma.customer.findUnique({ where: { email } });
  if (!customer) return { error: `No ReceipTap account for ${email}.` };

  const card = await prisma.loyaltyCard.findUnique({
    where: { merchantId_customerId: { merchantId, customerId: customer.id } },
  });
  if (!card) return { error: `${email} has no stamp card with you yet.` };
  if (card.stamps < program.stampsRequired) {
    return { error: `Not full yet — ${card.stamps} of ${program.stampsRequired} stamps.` };
  }

  await prisma.loyaltyCard.update({ where: { id: card.id }, data: { stamps: 0, lastRedeemedAt: new Date() } });
  return { message: `Redeemed ${program.rewardLabel} for ${email}. Their card is back to 0.` };
}

module.exports = router;
module.exports.awardLoyaltyStamps = awardLoyaltyStamps;
module.exports.stampsEarnedFor = stampsEarnedFor;
module.exports.computeLoyaltyPageData = computeLoyaltyPageData;
module.exports.saveLoyaltyProgram = saveLoyaltyProgram;
module.exports.redeemForCustomer = redeemForCustomer;
module.exports.describeEarnRule = describeEarnRule;
module.exports.resolveCardDesign = resolveCardDesign;
module.exports.readableInkFor = readableInkFor;
