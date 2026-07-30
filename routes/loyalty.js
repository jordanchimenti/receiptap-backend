// routes/loyalty.js
// Customer-facing punch card (join, earn punches, request a reward) and the
// merchant-facing in-person redemption confirm flow.
//
// Flow: customer joins on a receipt (1st punch immediate) -> future receipts
// linked to their account add punches (see incrementLoyaltyPunch, called
// from email-capture.js and customer-account.js) -> once at 5, customer taps
// "Use Reward", gets a short code -> merchant enters that code on their own
// dashboard and confirms -> customer's page (polling) notices the change and
// shows a signature pad -> customer signs -> card resets for the next cycle.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const prisma = require('../lib/prisma');

function requireCustomerAuth(req, res, next) {
  if (!req.session?.customerId) return res.status(401).json({ error: 'Not signed in' });
  next();
}

function requireMerchantAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

// Called after any transaction gets linked to a customer's account (joining
// the wallet, email capture, Google sign-in) -- adds a punch to that
// merchant's card if one already exists and isn't full or mid-redemption.
// Exported so the three existing linking endpoints can call it without
// duplicating this logic.
async function incrementLoyaltyPunch(merchantId, customerId) {
  const card = await prisma.loyaltyCard.findUnique({ where: { merchantId_customerId: { merchantId, customerId } } });
  if (!card) return; // not enrolled in this merchant's program -- nothing to punch
  if (card.redemptionStatus !== 'NONE') return; // don't punch while a redemption is in flight
  if (card.punches >= 5) return;

  await prisma.loyaltyCard.update({
    where: { id: card.id },
    data: { punches: card.punches + 1 },
  });
}

function generateRedemptionCode() {
  return String(crypto.randomInt(1000, 10000)); // 4 digits, easy to read off to a cashier
}

// --- Customer: join a merchant's loyalty program ----------------------------
router.post('/receipt/:transactionId/loyalty/join', requireCustomerAuth, async (req, res) => {
  const transaction = await prisma.transaction.findUnique({ where: { id: req.params.transactionId } });
  if (!transaction) return res.status(404).json({ error: 'Receipt not found' });

  const program = await prisma.loyaltyProgram.findUnique({ where: { merchantId: transaction.merchantId } });
  if (!program || !program.enabled) return res.status(400).json({ error: 'This merchant has no active loyalty program' });

  const card = await prisma.loyaltyCard.upsert({
    where: { merchantId_customerId: { merchantId: transaction.merchantId, customerId: req.session.customerId } },
    update: {}, // already enrolled -- joining again is a no-op, not a free extra punch
    create: { merchantId: transaction.merchantId, customerId: req.session.customerId, punches: 1 },
  });

  res.json({ success: true, cardId: card.id });
});

// --- Customer: current state of one of their cards (used for polling while --
// --- waiting on the merchant to confirm a redemption) -----------------------
router.get('/loyalty/:cardId/status', requireCustomerAuth, async (req, res) => {
  const card = await prisma.loyaltyCard.findUnique({ where: { id: req.params.cardId } });
  if (!card || card.customerId !== req.session.customerId) return res.status(404).json({ error: 'Not found' });

  res.json({ punches: card.punches, redemptionStatus: card.redemptionStatus, redemptionCode: card.redemptionCode });
});

// --- Customer: request a reward once the card is full -----------------------
router.post('/loyalty/:cardId/use-reward', requireCustomerAuth, async (req, res) => {
  const card = await prisma.loyaltyCard.findUnique({ where: { id: req.params.cardId } });
  if (!card || card.customerId !== req.session.customerId) return res.status(404).json({ error: 'Not found' });
  if (card.punches < 5) return res.status(400).json({ error: 'Card is not full yet' });
  if (card.redemptionStatus !== 'NONE') return res.status(400).json({ error: 'A redemption is already in progress' });

  const updated = await prisma.loyaltyCard.update({
    where: { id: card.id },
    data: { redemptionStatus: 'PENDING', redemptionCode: generateRedemptionCode() },
  });

  res.json({ success: true, redemptionCode: updated.redemptionCode });
});

// --- Customer: change their mind before the merchant confirms ---------------
router.post('/loyalty/:cardId/cancel-redeem', requireCustomerAuth, async (req, res) => {
  const card = await prisma.loyaltyCard.findUnique({ where: { id: req.params.cardId } });
  if (!card || card.customerId !== req.session.customerId) return res.status(404).json({ error: 'Not found' });
  if (card.redemptionStatus !== 'PENDING') return res.status(400).json({ error: 'Nothing to cancel' });

  await prisma.loyaltyCard.update({
    where: { id: card.id },
    data: { redemptionStatus: 'NONE', redemptionCode: null },
  });

  res.json({ success: true });
});

// --- Customer: sign to finalize a merchant-confirmed redemption -------------
// Resets the card for the next cycle in the same request -- the signature is
// the last step, there's nothing left to wait on after this.
router.post('/loyalty/:cardId/sign', requireCustomerAuth, async (req, res) => {
  const { signatureDataUrl } = req.body;
  if (!signatureDataUrl || !signatureDataUrl.startsWith('data:image/')) {
    return res.status(400).json({ error: 'A signature is required' });
  }

  const card = await prisma.loyaltyCard.findUnique({ where: { id: req.params.cardId } });
  if (!card || card.customerId !== req.session.customerId) return res.status(404).json({ error: 'Not found' });
  if (card.redemptionStatus !== 'CONFIRMED') return res.status(400).json({ error: 'Nothing awaiting a signature' });

  await prisma.loyaltyCard.update({
    where: { id: card.id },
    data: {
      punches: 0,
      redemptionStatus: 'NONE',
      redemptionCode: null,
      lastSignatureUrl: signatureDataUrl,
      lastRedeemedAt: new Date(),
    },
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
      include: { merchant: { include: { loyaltyProgram: true } } },
      orderBy: { updatedAt: 'desc' },
    }),
  ]);

  res.render('account-loyalty', {
    customerEmail: customer?.email || '',
    cards: cards
      .filter((c) => c.merchant.loyaltyProgram) // hide cards for a merchant that has since removed their program entirely
      .map((c) => ({
        id: c.id,
        merchantName: c.merchant.businessName,
        punches: c.punches,
        redemptionStatus: c.redemptionStatus,
        redemptionCode: c.redemptionCode,
        offerType: c.merchant.loyaltyProgram.offerType,
        offerValue: c.merchant.loyaltyProgram.offerValue,
      })),
  });
});

// --- Merchant: look up + confirm a redemption code in person ----------------
router.get('/dashboard/loyalty/redeem', requireMerchantAuth, async (req, res) => {
  const code = (req.query.code || '').trim();
  let lookup = null;
  let error = null;

  if (code) {
    const card = await prisma.loyaltyCard.findFirst({
      where: { merchantId: req.session.merchantId, redemptionCode: code, redemptionStatus: 'PENDING' },
      include: { customer: true },
    });
    if (!card) {
      error = 'No pending redemption with that code. Double check it with the customer.';
    } else {
      const program = await prisma.loyaltyProgram.findUnique({ where: { merchantId: req.session.merchantId } });
      lookup = {
        cardId: card.id,
        customerName: card.customer.name || card.customer.email,
        offerText: program.offerType === 'PERCENT' ? `${program.offerValue}% off` : `$${(program.offerValue / 100).toFixed(2)} off`,
      };
    }
  }

  res.render('loyalty-redeem', { code, lookup, error, confirmed: req.query.confirmed === '1' });
});

router.post('/dashboard/loyalty/redeem/confirm', requireMerchantAuth, async (req, res) => {
  const { cardId } = req.body;
  const card = await prisma.loyaltyCard.findUnique({ where: { id: cardId } });
  if (!card || card.merchantId !== req.session.merchantId || card.redemptionStatus !== 'PENDING') {
    return res.redirect('/dashboard/loyalty/redeem');
  }

  await prisma.loyaltyCard.update({ where: { id: card.id }, data: { redemptionStatus: 'CONFIRMED' } });
  res.redirect('/dashboard/loyalty/redeem?confirmed=1');
});

module.exports = router;
module.exports.incrementLoyaltyPunch = incrementLoyaltyPunch;
