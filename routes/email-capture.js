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
const prisma = require('../lib/prisma');

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
router.post('/receipt/:transactionId/capture-email', async (req, res) => {
  const { email } = req.body;
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }

  const transaction = await prisma.transaction.findUnique({
    where: { id: req.params.transactionId },
    include: { merchant: true },
  });
  if (!transaction) return res.status(404).json({ error: 'Receipt not found' });

  // Find or create the customer record by email — no password required for this path
  const customer = await prisma.customer.upsert({
    where: { email: email.toLowerCase() },
    update: {},
    create: { email: email.toLowerCase() },
  });

  // Link this transaction to them — same field the wallet feature uses,
  // which is what makes it visible to the merchant's customer-emails list too
  await prisma.transaction.update({
    where: { id: transaction.id },
    data: { customerId: customer.id },
  });

  // Kick off AI categorization — doesn't block this response
  if (!transaction.aiCategorizedAt) {
    categorizeInBackground(transaction, transaction.merchant.businessName);
  }

  req.session.customerId = customer.id;
  res.json({ success: true, email: customer.email });
});

// --- Google Sign-In capture -------------------------------------------------
// Client sends the ID token from Google Identity Services; we verify it
// server-side and pull the email out — never trust an email the client
// claims directly, only what Google's signed token confirms.
router.post('/receipt/:transactionId/capture-email-google', async (req, res) => {
  const { credential } = req.body;
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

  if (!transaction.aiCategorizedAt) {
    categorizeInBackground(transaction, transaction.merchant.businessName);
  }

  req.session.customerId = customer.id;
  res.json({ success: true, email: customer.email });
});

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const LAPSED_THRESHOLD_DAYS = 60; // no visit in 60+ days = win-back candidate, regardless of past visit count

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

router.get('/dashboard/customer-emails', requireMerchantAuth, async (req, res) => {
  const allCustomers = await getSegmentedCustomers(req.session.merchantId);
  const filter = ['new', 'repeat', 'lapsed'].includes(req.query.segment) ? req.query.segment : 'all';
  const filtered = filter === 'all' ? allCustomers : allCustomers.filter((c) => c.segment === filter);

  res.render('customer-emails', {
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
  });
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
