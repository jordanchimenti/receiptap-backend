// routes/admin.js
// Owner-only view of the whole platform. Mounted at /admin (deliberately NOT
// under /dashboard, so the merchant subscription gate never blocks the owner
// out of their own admin area).

const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { requireAdmin } = require('../middleware/requireAdmin');

const PRICE_USD = 49.99; // what an active subscription bills per month

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

module.exports = router;
