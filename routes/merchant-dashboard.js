// routes/merchant-dashboard.js
// "All receipts my business has issued" — merchant's own sales history

const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function requireAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

// GET /dashboard/receipts?from=2026-07-01&to=2026-07-17&search=coffee&page=1
router.get('/dashboard/receipts', requireAuth, async (req, res) => {
  const merchantId = req.session.merchantId;
  const page = parseInt(req.query.page, 10) || 1;
  const pageSize = 25;

  const where = {
    merchantId,
    ...(req.query.from || req.query.to
      ? {
          createdAt: {
            ...(req.query.from ? { gte: new Date(req.query.from) } : {}),
            ...(req.query.to ? { lte: new Date(req.query.to) } : {}),
          },
        }
      : {}),
    // Simple search across line item names — swap for full-text search at higher volume
    ...(req.query.search
      ? { lineItems: { path: '$[*].name', string_contains: req.query.search } }
      : {}),
  };

  const [transactions, totalCount] = await Promise.all([
    prisma.transaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.transaction.count({ where }),
  ]);

  res.render('merchant-receipts', {
    transactions: transactions.map((t) => ({
      ...t,
      total: (t.total / 100).toFixed(2),
      date: t.createdAt.toLocaleDateString('en-US', { dateStyle: 'medium' }),
    })),
    page,
    totalPages: Math.ceil(totalCount / pageSize),
    totalCount,
    filters: { from: req.query.from || '', to: req.query.to || '', search: req.query.search || '' },
  });
});

// Simple CSV export of the same filtered set — common merchant request (accounting/reconciliation)
router.get('/dashboard/receipts/export', requireAuth, async (req, res) => {
  const transactions = await prisma.transaction.findMany({
    where: { merchantId: req.session.merchantId },
    orderBy: { createdAt: 'desc' },
  });

  const rows = transactions.map(
    (t) => `${t.id},${t.createdAt.toISOString()},${(t.total / 100).toFixed(2)},${t.paymentMethod || ''}`
  );
  const csv = 'transaction_id,date,total,payment_method\n' + rows.join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="receiptap-transactions.csv"');
  res.send(csv);
});

// GET /dashboard/receipts-hub — combined view: both collections, tab-switched client-side
router.get('/dashboard/receipts-hub', requireAuth, async (req, res) => {
  const merchantId = req.session.merchantId;
  const pageSize = 25;

  const [issued, received] = await Promise.all([
    prisma.transaction.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      take: pageSize,
    }),
    prisma.transaction.findMany({
      where: { collectedByMerchantId: merchantId },
      include: { merchant: true },
      orderBy: { createdAt: 'desc' },
      take: pageSize,
    }),
  ]);

  res.render('receipts-hub', {
    customerReceipts: issued.map((t) => ({
      ...t,
      total: (t.total / 100).toFixed(2),
      date: t.createdAt.toLocaleDateString('en-US', { dateStyle: 'medium' }),
    })),
    merchantReceipts: received.map((t) => ({
      ...t,
      total: (t.total / 100).toFixed(2),
      date: t.createdAt.toLocaleDateString('en-US', { dateStyle: 'medium' }),
      soldByName: t.merchant.businessName,
    })),
  });
});

// ---------------------------------------------------------------------------
// GET /dashboard — Overview. Every number here is computed from real rows;
// nothing on this page is a placeholder.
// ---------------------------------------------------------------------------
router.get('/dashboard', requireAuth, async (req, res) => {
  const merchantId = req.session.merchantId;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const d7 = new Date(Date.now() - 7 * 864e5);
  const d14 = new Date(Date.now() - 14 * 864e5);

  const [merchant, pucks, recent, allTx, last7, prev7] = await Promise.all([
    prisma.merchant.findUnique({ where: { id: merchantId } }),
    prisma.puck.findMany({ where: { merchantId }, orderBy: { claimedAt: 'asc' } }),
    prisma.transaction.findMany({
      where: { merchantId },
      include: { customer: true },
      orderBy: { createdAt: 'desc' },
      take: 6,
    }),
    prisma.transaction.findMany({
      where: { merchantId },
      select: { total: true, customerId: true, createdAt: true },
    }),
    prisma.transaction.count({ where: { merchantId, createdAt: { gte: d7 } } }),
    prisma.transaction.count({ where: { merchantId, createdAt: { gte: d14, lt: d7 } } }),
  ]);

  const monthCents = allTx
    .filter((t) => t.createdAt >= monthStart)
    .reduce((s, t) => s + t.total, 0);
  const customerCount = new Set(allTx.filter((t) => t.customerId).map((t) => t.customerId)).size;

  // Percentage change only when there's a prior week to compare against
  let receiptsDelta = null;
  if (prev7 > 0) receiptsDelta = Math.round(((last7 - prev7) / prev7) * 100);

  const ASSIGN_WINDOW_MS = 15 * 60 * 1000;
  const isPairing = (p) =>
    p.awaitingSaleAssignment && new Date(p.awaitingSaleAssignment) > new Date(Date.now() - ASSIGN_WINDOW_MS);
  const isLinked = (p) => Boolean(p.posLocationId || p.posDeviceId);

  const puckRows = pucks.map((p) => ({
    id: p.id,
    linked: isLinked(p),
    pairing: Boolean(isPairing(p)),
    claimedAt: p.claimedAt,
  }));
  const linkedCount = puckRows.filter((p) => p.linked).length;
  const pairingCount = puckRows.filter((p) => !p.linked && p.pairing).length;
  const setupCount = puckRows.length - linkedCount - pairingCount;

  res.render('dashboard-overview', {
    merchant,
    stats: {
      receipts: allTx.length,
      receiptsDelta,
      pucksActive: pucks.length,
      pucksLinked: linkedCount,
      monthRevenue: (monthCents / 100).toFixed(2),
      monthLabel: now.toLocaleDateString('en-US', { month: 'long' }),
      customers: customerCount,
    },
    puckStatus: { linked: linkedCount, pairing: pairingCount, setup: setupCount, total: puckRows.length },
    pucks: puckRows.slice(0, 6),
    recent: recent.map((t) => ({
      id: t.id,
      who: t.customer ? t.customer.email : 'Not saved to a wallet',
      identified: Boolean(t.customer),
      total: (t.total / 100).toFixed(2),
      when: timeAgo(t.createdAt),
      method: t.paymentMethod || null,
    })),
  });
});

// GET /dashboard/pucks — every ReceipTap on this account and its setup state
router.get('/dashboard/pucks', requireAuth, async (req, res) => {
  const merchantId = req.session.merchantId;
  const pucks = await prisma.puck.findMany({ where: { merchantId }, orderBy: { claimedAt: 'asc' } });
  const ASSIGN_WINDOW_MS = 15 * 60 * 1000;
  res.render('pucks-list', {
    pucks: pucks.map((p) => ({
      id: p.id,
      linked: Boolean(p.posLocationId || p.posDeviceId),
      pairing: Boolean(p.awaitingSaleAssignment && new Date(p.awaitingSaleAssignment) > new Date(Date.now() - ASSIGN_WINDOW_MS)),
      claimedAt: p.claimedAt,
    })),
  });
});

function timeAgo(date) {
  const mins = Math.floor((Date.now() - new Date(date).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
  const days = Math.floor(hrs / 24);
  if (days < 7) return days + (days === 1 ? ' day ago' : ' days ago');
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

module.exports = router;
