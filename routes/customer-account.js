// routes/customer-account.js
// The "Phase 2" cross-merchant wallet — a customer's receipts from EVERY
// ReceipTap merchant they've shopped at, in one place.
// This is a separate identity/session from merchant accounts — a person
// could be both a shopper (Customer) and, elsewhere, a business (Merchant).

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { OAuth2Client } = require('google-auth-library');
const { categorizeTransaction } = require('../services/categorize-receipt');
const prisma = require('../lib/prisma');
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function categorizeInBackground(transaction, merchantName) {
  categorizeTransaction({ merchantName, lineItems: transaction.lineItems })
    .then((result) => {
      if (!result) return;
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

function requireCustomerAuth(req, res, next) {
  if (!req.session?.customerId) {
    return res.redirect(`/account/login?redirect=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

// --- Login / signup pages ---------------------------------------------------

router.get('/account/login', (req, res) => {
  res.render('account-login', {
    error: null,
    redirect: req.query.redirect || '/account/receipts',
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  });
});

router.get('/account/signup', (req, res) => {
  res.render('account-signup', {
    error: null,
    redirect: req.query.redirect || '/account/receipts',
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  });
});

// --- Signup / login (email + password) --------------------------------------

router.post('/account/signup', async (req, res) => {
  const { email, password } = req.body;
  const existing = await prisma.customer.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) return res.status(400).json({ error: 'Account already exists, log in instead' });

  const passwordHash = await bcrypt.hash(password, 10);
  const customer = await prisma.customer.create({ data: { email: email.toLowerCase(), passwordHash } });

  req.session.customerId = customer.id;
  res.json({ success: true });
});

router.post('/account/login', async (req, res) => {
  const { email, password } = req.body;
  const customer = await prisma.customer.findUnique({ where: { email: email.toLowerCase() } });
  if (!customer || !customer.passwordHash || !(await bcrypt.compare(password, customer.passwordHash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  req.session.customerId = customer.id;
  res.json({ success: true });
});

// --- Sign in with Google (doubles as signup — one step for both) ------------
// Used by both the login page and the signup page: if the Google account's
// email doesn't have a Customer record yet, one is created automatically.
// Same verify-then-upsert pattern as the receipt-save modal's Google option.
router.post('/account/google', async (req, res) => {
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

  if (!payload.email) return res.status(400).json({ error: 'Google account has no email' });

  const customer = await prisma.customer.upsert({
    where: { email: payload.email.toLowerCase() },
    update: { googleId: payload.sub, name: payload.name || undefined },
    create: { email: payload.email.toLowerCase(), googleId: payload.sub, name: payload.name || null },
  });

  req.session.customerId = customer.id;
  res.json({ success: true });
});

// --- Claiming a receipt into the wallet ------------------------------------

// Called silently by the receipt page's Save to Photos/PDF buttons when the
// browser already has a recognized customer session (from signing up on an
// earlier receipt) -- links THIS transaction to that same wallet too, with no
// separate "save to account" button needed. requireCustomerAuth is a no-op
// guard here since the caller only invokes this after confirming a session
// exists; a first-time visitor goes through the email-capture flow instead,
// which creates the session and links the transaction in one step.
router.post('/receipt/:transactionId/save', requireCustomerAuth, async (req, res) => {
  const transaction = await prisma.transaction.findUnique({
    where: { id: req.params.transactionId },
    include: { merchant: true },
  });
  if (!transaction) return res.status(404).json({ error: 'Receipt not found' });

  await prisma.transaction.update({
    where: { id: transaction.id },
    data: { customerId: req.session.customerId },
  });

  if (!transaction.aiCategorizedAt) {
    categorizeInBackground(transaction, transaction.merchant.businessName);
  }

  res.json({ success: true });
});

// --- The wallet itself ------------------------------------------------------

// Shared by the wallet page and its CSV export, so the two can never drift
// out of sync on what "the current filters" actually match.
function buildWalletWhere(customerId, { search, from, to, category }) {
  return {
    customerId,
    ...(search ? { merchant: { businessName: { contains: search, mode: 'insensitive' } } } : {}),
    ...(category ? { aiCategory: category } : {}),
    ...(from || to
      ? {
          createdAt: {
            ...(from ? { gte: new Date(from) } : {}),
            // Include the entire "to" day, not just midnight at its start
            ...(to ? { lte: new Date(new Date(to).setHours(23, 59, 59, 999)) } : {}),
          },
        }
      : {}),
  };
}

// GET /account/receipts — every receipt this customer has saved, across ALL merchants
// Supports ?search=<business name>, ?from=&to=<date range>, and ?category=<ai category>
router.get('/account/receipts', requireCustomerAuth, async (req, res) => {
  const { search, from, to, category } = req.query;
  const where = buildWalletWhere(req.session.customerId, { search, from, to, category });

  const [customer, transactions, monthTransactions, categoryRows] = await Promise.all([
    prisma.customer.findUnique({ where: { id: req.session.customerId } }),
    prisma.transaction.findMany({
      where,
      include: { merchant: true }, // needs merchant business name for display
      orderBy: { createdAt: 'desc' },
    }),
    // This month's totals — always unfiltered, so the summary stays stable
    // no matter what the user is currently searching for
    prisma.transaction.findMany({
      where: {
        customerId: req.session.customerId,
        createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) },
      },
      select: { total: true, merchantId: true },
    }),
    // Distinct categories this customer actually has, for the filter chips
    prisma.transaction.findMany({
      where: { customerId: req.session.customerId, aiCategory: { not: null } },
      select: { aiCategory: true },
      distinct: ['aiCategory'],
    }),
  ]);

  const monthTotal = monthTransactions.reduce((sum, t) => sum + t.total, 0);
  const monthStores = new Set(monthTransactions.map((t) => t.merchantId)).size;

  res.render('customer-wallet', {
    customerEmail: customer?.email || '',
    summary: {
      monthTotal: (monthTotal / 100).toFixed(2),
      monthStores,
      monthName: new Date().toLocaleDateString('en-US', { month: 'long' }),
    },
    categories: categoryRows.map((r) => r.aiCategory).sort(),
    receipts: transactions.map((t) => ({
      ...t,
      total: (t.total / 100).toFixed(2),
      date: t.createdAt.toLocaleDateString('en-US', { dateStyle: 'medium' }),
      merchantName: t.merchant.businessName,
      aiCategory: t.aiCategory,
      aiTaxDeductible: t.aiTaxDeductible,
      aiReasoning: t.aiReasoning,
    })),
    filters: { search: search || '', from: from || '', to: to || '', category: category || '' },
  });
});

// GET /account/receipts/export — CSV of whatever the wallet's current filters match
router.get('/account/receipts/export', requireCustomerAuth, async (req, res) => {
  const { search, from, to, category } = req.query;
  const where = buildWalletWhere(req.session.customerId, { search, from, to, category });

  const transactions = await prisma.transaction.findMany({
    where,
    include: { merchant: true },
    orderBy: { createdAt: 'desc' },
  });

  const rows = transactions.map(
    (t) =>
      `${t.id},${t.createdAt.toISOString()},${t.merchant.businessName},${(t.total / 100).toFixed(2)},${t.aiCategory || ''}`
  );
  const csv = 'transaction_id,date,business,total,category\n' + rows.join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="receiptap-my-receipts.csv"');
  res.send(csv);
});

// POST /account/logout — clears only the customer session (a person could be
// logged in as a merchant in the same browser; don't log them out of that too)
router.post('/account/logout', (req, res) => {
  delete req.session.customerId;
  res.redirect('/account/login');
});

module.exports = router;
