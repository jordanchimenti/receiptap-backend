// routes/repeat-customers.js
// Analytics only: shows merchants which customers keep coming back, using
// the AI category data already captured per receipt. Deliberately does NOT
// send marketing email on the merchant's behalf — a raw SMTP send has no
// unsubscribe handling and no sender-reputation infrastructure, so it isn't
// a safe or reliable way to do real marketing. CSV export lets merchants
// plug this into whatever email platform they already use (Mailchimp,
// Klaviyo, etc.) — tools actually built for compliant, deliverable marketing.

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

function requireAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

// Repeat customer = 2+ transactions with this merchant. Computes visit
// count, total spent, most recent visit, and most common AI-assigned
// category (the personalization hook for whatever campaign they build).
async function getRepeatCustomers(merchantId) {
  const transactions = await prisma.transaction.findMany({
    where: { merchantId, customerId: { not: null } },
    include: { customer: true },
    orderBy: { createdAt: 'desc' },
  });

  const byCustomer = new Map();
  for (const t of transactions) {
    if (!byCustomer.has(t.customerId)) {
      byCustomer.set(t.customerId, {
        customerId: t.customerId,
        email: t.customer.email,
        name: t.customer.name,
        visitCount: 0,
        totalSpent: 0,
        lastVisit: t.createdAt,
        categoryCounts: {},
      });
    }
    const entry = byCustomer.get(t.customerId);
    entry.visitCount += 1;
    entry.totalSpent += t.total;
    if (t.createdAt > entry.lastVisit) entry.lastVisit = t.createdAt;
    if (t.aiCategory) {
      entry.categoryCounts[t.aiCategory] = (entry.categoryCounts[t.aiCategory] || 0) + 1;
    }
  }

  return [...byCustomer.values()]
    .filter((c) => c.visitCount >= 2)
    .map((c) => {
      const topCategory = Object.entries(c.categoryCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      return {
        customerId: c.customerId,
        email: c.email,
        name: c.name,
        visitCount: c.visitCount,
        totalSpent: (c.totalSpent / 100).toFixed(2),
        lastVisit: c.lastVisit,
        daysSinceLastVisit: Math.floor((Date.now() - c.lastVisit.getTime()) / (1000 * 60 * 60 * 24)),
        topCategory,
      };
    })
    .sort((a, b) => b.visitCount - a.visitCount);
}

// Shared by GET /dashboard/repeat-customers and GET /account/business/customers
// (the wallet's dark reskin) -- see routes/account-business.js.
async function computeRepeatCustomersData(merchantId) {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
  const customers = await getRepeatCustomers(merchantId);

  return {
    businessName: merchant.businessName,
    customers: customers.map((c) => ({
      ...c,
      lastVisit: c.lastVisit.toLocaleDateString('en-US', { dateStyle: 'medium' }),
    })),
  };
}

router.get('/dashboard/repeat-customers', requireAuth, async (req, res) => {
  res.render('repeat-customers', await computeRepeatCustomersData(req.session.merchantId));
});

// CSV export — designed to drop straight into an email platform's contact
// import (most accept a CSV with an email column plus arbitrary extra
// columns for segmentation/personalization).
router.get('/dashboard/repeat-customers/export', requireAuth, async (req, res) => {
  const customers = await getRepeatCustomers(req.session.merchantId);

  const rows = customers.map(
    (c) =>
      `${c.email},${c.name || ''},${c.visitCount},${c.totalSpent},${c.lastVisit.toISOString()},${c.daysSinceLastVisit},${c.topCategory || ''}`
  );
  const csv = 'email,name,visit_count,total_spent,last_visit,days_since_last_visit,top_category\n' + rows.join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="receiptap-repeat-customers.csv"');
  res.send(csv);
});

module.exports = router;
module.exports.computeRepeatCustomersData = computeRepeatCustomersData;
