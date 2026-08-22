// routes/email-capture.js
// Gates "Save Receipt" behind an email or Google sign-in capture.
// Reuses the existing Customer model + Transaction.customerId link (same
// mechanism as the wallet "save" feature) — no separate email table needed,
// since a merchant's collected emails are just: customers linked to THEIR
// transactions. See GET /dashboard/customer-emails at the bottom.

const express = require('express');
const router = express.Router();
const { OAuth2Client } = require('google-auth-library');
const { categorizeTransaction } = require('../services/categorize-receipt');
const { incrementLoyaltyPunch } = require('./loyalty');
const { recordShopperConsent } = require('../services/shopperConsentService');
const { deleteShopperByEmail } = require('../services/dataRetentionService');
const prisma = require('../lib/prisma');
const { attributeCustomerToMerchant } = require('../lib/referralAttribution');
const { SHOPPER_CONSENT } = require('../config/legal');
const { ensureMerchantAffiliate } = require('./affiliates');
const { recordIdentifierByHash } = require('../services/shopperIdentity');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Fire-and-forget: kicks off categorization without making the save/print
// flow wait on an AI call. Result is written to the DB whenever it finishes;
// the wallet just won't show a category badge until the next page load.
function categorizeInBackground(transaction, merchantName) {
  categorizeTransaction({ merchantName, lineItems: transaction.lineItems })
    .then((result) => {
      if (!result) return; // categorization skipped or failed — leave fields null, no retry storm
      return prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          aiCategory: result.category,
          aiTaxDeductible: result.taxDeductible,
          aiReasoning: result.reasoning,
          aiCategorizedAt: new Date(),
        },
      });
    })
    .catch((err) => console.error('[categorize-receipt] background update failed:', err.message));
}

function requireMerchantAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

// --- Plain email capture (no password — this is a quick capture gate, ---
// --- not a full account signup. Upgrading to a real login is optional. ---

// Links a passive identifier to this shopper, but ONLY with their explicit
// cross-merchant recognition consent. Every early return below is a case where
// we must not create a link:
//   - consent not given (or not given on THIS receipt)
//   - no fingerprint captured -- a cash sale, or a platform that doesn't
//     expose one, which is every platform except Square today
// Platform is taken from the transaction itself and stored on the row, so a
// Square fingerprint can never be matched against another platform's value.
//
// Best-effort by design: a failure here must never break saving a receipt.
const PLATFORM_BY_POS_PROVIDER = {
  square: 'SQUARE',
  clover: 'CLOVER',
  shopify: 'SHOPIFY',
  lightspeed: 'LIGHTSPEED',
  toast: 'TOAST',
};

async function linkShopperIdentifier({ transaction, customerId, crossMerchantGranted }) {
  if (!crossMerchantGranted) return;
  if (!transaction.cardFingerprintHash) return;

  const sourcePlatform = PLATFORM_BY_POS_PROVIDER[transaction.posProvider];
  if (!sourcePlatform) return;

  try {
    // The hash is all we have -- the raw fingerprint was discarded at the
    // webhook -- so this uses the *ByHash entry point. Idempotent: the same
    // card at the same shop doesn't pile up rows, and re-consenting revives a
    // previously revoked link rather than duplicating it.
    await recordIdentifierByHash(
      customerId,
      'CARD_FINGERPRINT',
      transaction.cardFingerprintHash,
      sourcePlatform
    );
  } catch (err) {
    console.error('Shopper identifier link failed (receipt save continued):', err.message);
  }
}

router.post('/receipt/:transactionId/capture-email', async (req, res) => {
  const { name, email, marketingOptIn, crossMerchantOptIn } = req.body;
  const trimmedName = (name || '').trim();
  if (!trimmedName) {
    return res.status(400).json({ error: 'Enter your name' });
  }
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }

  const transaction = await prisma.transaction.findUnique({
    where: { id: req.params.transactionId },
    include: { merchant: true },
  });
  if (!transaction) return res.status(404).json({ error: 'Receipt not found' });

  // Find or create the customer record by email — no password required for this path.
  // On an existing account the name is only filled in when it's still blank:
  // whatever they told us before (or Google told us) is the better record, and
  // a typo at someone else's counter shouldn't rewrite it.
  const customer = await prisma.customer.upsert({
    where: { email: email.toLowerCase() },
    update: {},
    create: { email: email.toLowerCase(), name: trimmedName },
  });
  if (!customer.name && trimmedName) {
    await prisma.customer.update({ where: { id: customer.id }, data: { name: trimmedName } });
  }

  // Link this transaction to them — same field the wallet feature uses,
  // which is what makes it visible to the merchant's customer-emails list too
  await prisma.transaction.update({
    where: { id: transaction.id },
    data: { customerId: customer.id },
  });
  await incrementLoyaltyPunch(transaction.merchantId, customer.id);
  await recordShopperConsent({ receiptId: transaction.id, merchantId: transaction.merchantId, email, marketingGranted: marketingOptIn, crossMerchantGranted: crossMerchantOptIn }, req);

  // Kick off AI categorization — doesn't block this response
  if (!transaction.aiCategorizedAt) {
    categorizeInBackground(transaction, transaction.merchant.businessName);
  }

  req.session.customerId = customer.id;
  await linkShopperIdentifier({ transaction, customerId: customer.id, crossMerchantGranted: crossMerchantOptIn });
  // This merchant just introduced someone to ReceipTap. Credit them, so if
  // that person ever signs their own business up the commission follows.
  // Best-effort: a failure here must never break saving a receipt.
  try {
    const affiliate = await ensureMerchantAffiliate(transaction.merchantId);
    await attributeCustomerToMerchant({ prisma, customerId: customer.id, affiliate, req, res });
  } catch (err) {
    console.error('Referral attribution failed (receipt save continued):', err.message);
  }
  res.json({ success: true, email: customer.email, redirect: '/account/welcome' });
});

// --- Google Sign-In capture -------------------------------------------------
// Client sends the ID token from Google Identity Services; we verify it
// server-side and pull the email out — never trust an email the client
// claims directly, only what Google's signed token confirms.
router.post('/receipt/:transactionId/capture-email-google', async (req, res) => {
  const { credential, marketingOptIn, crossMerchantOptIn } = req.body;
  if (!credential) return res.status(400).json({ error: 'Missing Google credential' });

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    return res.status(401).json({ error: 'Could not verify Google sign-in' });
  }

  const email = payload.email;
  if (!email) return res.status(400).json({ error: 'Google account has no email' });

  const transaction = await prisma.transaction.findUnique({
    where: { id: req.params.transactionId },
    include: { merchant: true },
  });
  if (!transaction) return res.status(404).json({ error: 'Receipt not found' });

  const customer = await prisma.customer.upsert({
    where: { email: email.toLowerCase() },
    update: { googleId: payload.sub, name: payload.name || undefined },
    create: { email: email.toLowerCase(), googleId: payload.sub, name: payload.name || null },
  });

  await prisma.transaction.update({
    where: { id: transaction.id },
    data: { customerId: customer.id },
  });
  await incrementLoyaltyPunch(transaction.merchantId, customer.id);
  await recordShopperConsent({ receiptId: transaction.id, merchantId: transaction.merchantId, email, marketingGranted: marketingOptIn, crossMerchantGranted: crossMerchantOptIn }, req);

  if (!transaction.aiCategorizedAt) {
    categorizeInBackground(transaction, transaction.merchant.businessName);
  }

  req.session.customerId = customer.id;
  await linkShopperIdentifier({ transaction, customerId: customer.id, crossMerchantGranted: crossMerchantOptIn });
  // This merchant just introduced someone to ReceipTap. Credit them, so if
  // that person ever signs their own business up the commission follows.
  // Best-effort: a failure here must never break saving a receipt.
  try {
    const affiliate = await ensureMerchantAffiliate(transaction.merchantId);
    await attributeCustomerToMerchant({ prisma, customerId: customer.id, affiliate, req, res });
  } catch (err) {
    console.error('Referral attribution failed (receipt save continued):', err.message);
  }
  res.json({ success: true, email: customer.email, redirect: '/account/welcome' });
});

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const LAPSED_THRESHOLD_DAYS = 30; // no visit in 30+ days = win-back candidate, regardless of past visit count

// --- Merchant-facing: the emails this collects for THAT merchant -----------
// Segments customers for email marketing:
//   new     = exactly 1 visit ever (haven't come back yet — welcome/nurture angle)
//   repeat  = 2+ visits AND still active (last visit within the threshold — loyalty/upsell angle)
//   lapsed  = last visit older than the threshold, regardless of visit count — win-back angle
// A customer is in exactly one segment — new/repeat is about visit count,
// lapsed overrides both once they've gone quiet, since "used to be a repeat
// customer but haven't been back in 4 months" is a different marketing
// conversation than "still actively repeat."
async function getSegmentedCustomers(merchantId) {
  const transactions = await prisma.transaction.findMany({
    where: { merchantId, customerId: { not: null } },
    include: { customer: true },
    orderBy: { createdAt: 'asc' },
  });

  const byEmail = new Map();
  for (const t of transactions) {
    const email = t.customer.email;
    if (!byEmail.has(email)) {
      byEmail.set(email, { email, name: t.customer.name, firstSeen: t.createdAt, lastVisit: t.createdAt, visitCount: 0 });
    }
    const entry = byEmail.get(email);
    entry.visitCount += 1;
    if (t.createdAt > entry.lastVisit) entry.lastVisit = t.createdAt;
  }

  const now = Date.now();
  return [...byEmail.values()].map((c) => {
    const daysSinceLastVisit = Math.floor((now - c.lastVisit.getTime()) / (1000 * 60 * 60 * 24));
    let segment;
    if (daysSinceLastVisit > LAPSED_THRESHOLD_DAYS) segment = 'lapsed';
    else if (c.visitCount >= 2) segment = 'repeat';
    else segment = 'new';
    return { ...c, daysSinceLastVisit, segment };
  });
}

// Shared by GET /dashboard/customer-emails and GET /account/business/emails
// (the wallet's dark reskin) -- see routes/account-business.js.
async function computeCustomerEmailsData(merchantId, query = {}) {
  const allCustomers = await getSegmentedCustomers(merchantId);
  const filter = ['new', 'repeat', 'lapsed'].includes(query.segment) ? query.segment : 'all';
  const filtered = filter === 'all' ? allCustomers : allCustomers.filter((c) => c.segment === filter);

  // Shopper data-request lookup -- a merchant checking what a specific
  // deletion request would actually remove, before confirming it. Always a
  // dry run: this route never deletes anything itself, only previews.
  const lookupEmail = typeof query.lookupEmail === 'string' ? query.lookupEmail.trim() : '';
  const lookupResult = lookupEmail
    ? await deleteShopperByEmail(lookupEmail, merchantId, { dryRun: true })
    : null;

  return {
    emails: filtered.map((c) => ({
      ...c,
      firstSeen: c.firstSeen.toLocaleDateString('en-US', { dateStyle: 'medium' }),
      lastVisit: c.lastVisit.toLocaleDateString('en-US', { dateStyle: 'medium' }),
    })),
    counts: {
      all: allCustomers.length,
      new: allCustomers.filter((c) => c.segment === 'new').length,
      repeat: allCustomers.filter((c) => c.segment === 'repeat').length,
      lapsed: allCustomers.filter((c) => c.segment === 'lapsed').length,
    },
    activeFilter: filter,
    lookupEmail,
    lookupResult,
    deleted: query.deleted === '1',
  };
}

router.get('/dashboard/customer-emails', requireMerchantAuth, async (req, res) => {
  res.render('customer-emails', await computeCustomerEmailsData(req.session.merchantId, req.query));
});

// Confirms and executes what the lookup above only previewed. Deliberately
// separate from the GET route -- a lookup is a read, this is the
// irreversible action, and it should only ever happen from an explicit
// form POST, never as a side effect of loading a page.
router.post('/dashboard/customer-emails/delete', requireMerchantAuth, async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
  if (!email) return res.redirect('/dashboard/customer-emails');

  await deleteShopperByEmail(email, req.session.merchantId, { dryRun: false });
  res.redirect('/dashboard/customer-emails?deleted=1');
});

router.get('/dashboard/customer-emails/export', requireMerchantAuth, async (req, res) => {
  const allCustomers = await getSegmentedCustomers(req.session.merchantId);
  const filter = ['new', 'repeat', 'lapsed'].includes(req.query.segment) ? req.query.segment : 'all';
  const filtered = filter === 'all' ? allCustomers : allCustomers.filter((c) => c.segment === filter);

  const rows = filtered.map(
    (c) => `${c.email},${c.name || ''},${c.segment},${c.visitCount},${c.lastVisit.toISOString()},${c.daysSinceLastVisit}`
  );
  const csv = 'email,name,segment,visit_count,last_visit,days_since_last_visit\n' + rows.join('\n');

  const filenameSuffix = filter === 'all' ? '' : `-${filter}`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="receiptap-customer-emails${filenameSuffix}.csv"`);
  res.send(csv);
});

module.exports = router;
module.exports.computeCustomerEmailsData = computeCustomerEmailsData;
