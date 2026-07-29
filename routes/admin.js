// routes/admin.js
// Owner-only view of the whole platform. Mounted at /admin (deliberately NOT
// under /dashboard, so the merchant subscription gate never blocks the owner
// out of their own admin area).

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { requireAdmin } = require('../middleware/requireAdmin');
const { SQUARE_BASE_URL, createTestSale } = require('../services/squareService');

const PRICE_USD = 49.99; // what an active subscription bills per month

// Uppercase digits + letters only, excluding ambiguous characters
// (0/O, 1/I/l) — used for both the id and the claim code so a puck minted
// from the admin panel is uppercase end to end.
const PUCK_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

// Maps crypto.randomBytes onto an alphabet without modulo bias, by
// rejecting any byte value that would over-represent some characters.
function randomAlphabetString(alphabet, length) {
  const maxValid = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    const bytes = crypto.randomBytes(length - out.length);
    for (const byte of bytes) {
      if (byte < maxValid) out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

// GET /admin — platform overview
router.get('/admin', requireAdmin, async (req, res) => {
  const d30 = new Date(Date.now() - 30 * 864e5);
  const d7 = new Date(Date.now() - 7 * 864e5);

  const [merchants, pucks, txAgg, txCount, customers, newMerchants7, tx30] = await Promise.all([
    prisma.merchant.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, businessName: true, email: true, createdAt: true,
        subscriptionStatus: true, squareMerchantId: true, shopifyShopDomain: true,
        _count: { select: { issuedReceipts: true, pucks: true } },
      },
    }),
    prisma.puck.findMany({ select: { status: true, merchantId: true, posLocationId: true, posDeviceId: true } }),
    prisma.transaction.aggregate({ _sum: { total: true } }),
    prisma.transaction.count(),
    prisma.customer.count(),
    prisma.merchant.count({ where: { createdAt: { gte: d7 } } }),
    prisma.transaction.count({ where: { createdAt: { gte: d30 } } }),
  ]);

  const byStatus = merchants.reduce((acc, m) => {
    acc[m.subscriptionStatus] = (acc[m.subscriptionStatus] || 0) + 1;
    return acc;
  }, {});

  const activeCount = byStatus.ACTIVE || 0;
  const trialingCount = byStatus.TRIALING || 0;

  const pucksClaimed = pucks.filter((p) => p.status === 'CLAIMED').length;
  const pucksLinked = pucks.filter((p) => p.posLocationId || p.posDeviceId).length;

  res.render('admin-overview', {
    admin: res.locals.adminUser,
    activeTab: 'overview',
    stats: {
      merchants: merchants.length,
      newMerchants7,
      // MRR counts only merchants actually being billed. Trials are pipeline,
      // not revenue — conflating them is the fastest way to lie to yourself.
      mrr: (activeCount * PRICE_USD).toFixed(2),
      trialPipeline: (trialingCount * PRICE_USD).toFixed(2),
      receipts: txCount,
      receipts30: tx30,
      gmv: ((txAgg._sum.total || 0) / 100).toFixed(2),
      customers,
    },
    byStatus: {
      ACTIVE: activeCount,
      TRIALING: trialingCount,
      PAST_DUE: byStatus.PAST_DUE || 0,
      INCOMPLETE: byStatus.INCOMPLETE || 0,
      CANCELED: byStatus.CANCELED || 0,
    },
    pucks: {
      total: pucks.length,
      unclaimed: pucks.length - pucksClaimed,
      claimed: pucksClaimed,
      linked: pucksLinked,
    },
    merchants: merchants.map((m) => ({
      id: m.id,
      name: m.businessName,
      email: m.email,
      status: m.subscriptionStatus,
      receipts: m._count.issuedReceipts,
      pucks: m._count.pucks,
      pos: m.squareMerchantId ? 'Square' : m.shopifyShopDomain ? 'Shopify' : null,
      joined: m.createdAt,
    })),
  });
});

const PUCKS_PER_PAGE = 10;

function puckUrl(req, id) {
  const baseUrl = process.env.PUCK_BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${baseUrl}/r/${id}`;
}

// GET /admin/pucks — real, paginated history of every puck generated from
// this admin panel (source: 'ADMIN' only — bulk hardware-order pucks from
// scripts/generate-batch.js don't show up here).
router.get('/admin/pucks', requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const [total, pucks] = await Promise.all([
    prisma.puck.count({ where: { source: 'ADMIN' } }),
    prisma.puck.findMany({
      where: { source: 'ADMIN' },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PUCKS_PER_PAGE,
      take: PUCKS_PER_PAGE,
    }),
  ]);

  res.render('admin-pucks', {
    admin: res.locals.adminUser,
    activeTab: 'pucks',
    error: req.query.error || null,
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / PUCKS_PER_PAGE)),
    pucks: pucks.map((p) => ({ ...p, url: puckUrl(req, p.id) })),
  });
});

// POST /admin/pucks/generate — mints one UNCLAIMED puck on demand, for
// hand-testing against a physical NFC tag. Redirects back to the real,
// persisted list — the new puck is just its top row.
router.post('/admin/pucks/generate', requireAdmin, async (req, res) => {
  try {
    let id, claimCode;
    let attempts = 0;
    do {
      if (attempts++ > 20) throw new Error('Could not generate a unique puck — please try again.');
      id = randomAlphabetString(PUCK_ALPHABET, 10);
      claimCode = randomAlphabetString(PUCK_ALPHABET, 6);
    } while (await prisma.puck.findFirst({ where: { OR: [{ id }, { claimCode }] } }));

    await prisma.puck.create({ data: { id, claimCode, status: 'UNCLAIMED', source: 'ADMIN' } });
    res.redirect('/admin/pucks');
  } catch (err) {
    res.redirect(`/admin/pucks?error=${encodeURIComponent(err.message)}`);
  }
});

// GET /admin/pucks/export — CSV of every admin-generated puck (not just the
// current page).
router.get('/admin/pucks/export', requireAdmin, async (req, res) => {
  const pucks = await prisma.puck.findMany({ where: { source: 'ADMIN' }, orderBy: { createdAt: 'desc' } });
  const rows = pucks.map((p) =>
    [csvField(p.id), csvField(p.claimCode), csvField(puckUrl(req, p.id)), csvField(p.status), p.createdAt.toISOString()].join(',')
  );
  const csv = 'id,claim_code,url,status,created_at\n' + rows.join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="receiptap-generated-pucks.csv"');
  res.send(csv);
});

// Shared by the page and its CSV export so both always show the same numbers.
async function getAllCustomers() {
  const customers = await prisma.customer.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      transactions: {
        select: { merchantId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  return customers.map((c) => ({
    email: c.email,
    name: c.name,
    signupMethod: c.googleId ? 'Google' : 'Email',
    merchantCount: new Set(c.transactions.map((t) => t.merchantId)).size,
    receiptCount: c.transactions.length,
    firstSeen: c.createdAt,
    lastActivity: c.transactions[0]?.createdAt || c.createdAt,
  }));
}

// Quotes a CSV field only when it needs it (contains a comma, quote, or
// newline) — names are free-text (typed, or pulled from a Google account),
// so they can't be trusted not to contain a comma.
function csvField(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

// GET /admin/customers — every customer (collected email) across ALL
// merchants on the platform, not scoped to one merchant like
// /dashboard/customer-emails is.
router.get('/admin/customers', requireAdmin, async (req, res) => {
  const customers = await getAllCustomers();
  res.render('admin-customers', {
    admin: res.locals.adminUser,
    activeTab: 'customers',
    customers,
  });
});

// GET /admin/customers/export — same data as the page above, as a CSV.
router.get('/admin/customers/export', requireAdmin, async (req, res) => {
  const customers = await getAllCustomers();

  const rows = customers.map((c) =>
    [
      csvField(c.email),
      csvField(c.name || ''),
      csvField(c.signupMethod),
      c.merchantCount,
      c.receiptCount,
      c.firstSeen.toISOString(),
      c.lastActivity.toISOString(),
    ].join(',')
  );
  const csv = 'email,name,signup_method,merchant_count,receipt_count,first_seen,last_activity\n' + rows.join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="receiptap-customers.csv"');
  res.send(csv);
});

// GET /admin/merchants/export — CSV of every merchant account (business +
// email), for the "All merchants" table on the overview page.
router.get('/admin/merchants/export', requireAdmin, async (req, res) => {
  const merchants = await prisma.merchant.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      businessName: true,
      email: true,
      createdAt: true,
      subscriptionStatus: true,
      squareMerchantId: true,
      shopifyShopDomain: true,
      _count: { select: { issuedReceipts: true, pucks: true } },
    },
  });

  const rows = merchants.map((m) =>
    [
      csvField(m.businessName),
      csvField(m.email),
      csvField(m.subscriptionStatus),
      csvField(m.squareMerchantId ? 'Square' : m.shopifyShopDomain ? 'Shopify' : ''),
      m._count.issuedReceipts,
      m._count.pucks,
      m.createdAt.toISOString(),
    ].join(',')
  );
  const csv = 'business_name,email,subscription_status,pos,receipts,pucks,joined_at\n' + rows.join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="receiptap-merchants.csv"');
  res.send(csv);
});

// GET /admin/test-pos — a virtual terminal: rings a real Square sandbox sale
// so the whole webhook -> puck-binding path can be tested from a browser
// (e.g. a second phone) instead of running scripts or hand-editing the DB.
router.get('/admin/test-pos', requireAdmin, async (req, res) => {
  const merchant = await prisma.merchant.findFirst({ where: { squareAccessToken: { not: null } } });

  let locations = [];
  if (merchant?.squareAccessToken) {
    const locRes = await fetch(`${SQUARE_BASE_URL}/v2/locations`, {
      headers: { Authorization: `Bearer ${merchant.squareAccessToken}` },
    }).catch(() => null);
    const data = await locRes?.json().catch(() => null);
    locations = data?.locations || [];
  }

  res.render('admin-test-pos', {
    admin: res.locals.adminUser,
    activeTab: 'test-pos',
    locations,
    connected: Boolean(merchant?.squareAccessToken),
    error: req.query.error || null,
    result: req.query.orderId
      ? { orderId: req.query.orderId, paymentId: req.query.paymentId, total: req.query.total }
      : null,
  });
});

// POST /admin/test-pos/charge — creates a real Order + Payment via the
// elevated sandbox test token, then redirects back with the result.
router.post('/admin/test-pos/charge', requireAdmin, async (req, res) => {
  try {
    const { locationId, itemName, itemPrice, itemQty } = req.body;

    const lineItems = [];
    for (let i = 0; i < itemName.length; i++) {
      if (!itemName[i] || !itemPrice[i]) continue;
      lineItems.push({
        name: itemName[i],
        unitPrice: Math.round(Number(itemPrice[i]) * 100),
        quantity: parseInt(itemQty[i], 10) || 1,
      });
    }
    if (lineItems.length === 0) throw new Error('Enter at least one line item.');

    const { order, payment } = await createTestSale(locationId, lineItems);

    res.redirect(
      `/admin/test-pos?orderId=${encodeURIComponent(order.id)}&paymentId=${encodeURIComponent(payment.id)}&total=${encodeURIComponent((payment.total_money.amount / 100).toFixed(2))}`
    );
  } catch (err) {
    res.redirect(`/admin/test-pos?error=${encodeURIComponent(err.message)}`);
  }
});

module.exports = router;
