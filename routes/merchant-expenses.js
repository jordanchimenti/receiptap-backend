// routes/merchant-expenses.js
// "Receipts my business has RECEIVED" — the flip side of merchant-dashboard.js.
// A merchant account can also act as a purchaser at another ReceipTap merchant
// (e.g. buying supplies) and save that receipt into their own expense records.

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

function requireAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

// NOTE: the "Save as Business Expense" receipt-page button that used to POST
// to /receipt/:transactionId/save-expense has been removed (retired
// intentionally) -- this was the only way collectedByMerchantId ever got
// set, so no new expenses can be filed going forward. The page below still
// works as a view-only record of whatever was collected while that button
// existed.

function dateRangeWhere(from, to) {
  return from || to
    ? {
        createdAt: {
          ...(from ? { gte: new Date(from) } : {}),
          // Include the entire "to" day, not just midnight at its start
          ...(to ? { lte: new Date(new Date(to).setHours(23, 59, 59, 999)) } : {}),
        },
      }
    : {};
}

// GET /dashboard/expenses?from=&to= — everything this merchant has bought elsewhere and saved
router.get('/dashboard/expenses', requireAuth, async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const pageSize = 25;
  const { from, to } = req.query;

  const where = { collectedByMerchantId: req.session.merchantId, ...dateRangeWhere(from, to) };

  const [transactions, totalCount] = await Promise.all([
    prisma.transaction.findMany({
      where,
      include: { merchant: true }, // the OTHER merchant who sold this to them
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.transaction.count({ where }),
  ]);

  res.render('merchant-expenses', {
    expenses: transactions.map((t) => ({
      ...t,
      total: (t.total / 100).toFixed(2),
      date: t.createdAt.toLocaleDateString('en-US', { dateStyle: 'medium' }),
      soldByName: t.merchant.businessName,
    })),
    page,
    totalPages: Math.ceil(totalCount / pageSize),
    totalCount,
    filters: { from: from || '', to: to || '' },
  });
});

// Same idea as the sales export — useful for expense tracking / tax prep
router.get('/dashboard/expenses/export', requireAuth, async (req, res) => {
  const { from, to } = req.query;
  const transactions = await prisma.transaction.findMany({
    where: { collectedByMerchantId: req.session.merchantId, ...dateRangeWhere(from, to) },
    include: { merchant: true },
    orderBy: { createdAt: 'desc' },
  });

  const rows = transactions.map(
    (t) => `${t.id},${t.createdAt.toISOString()},${t.merchant.businessName},${(t.total / 100).toFixed(2)}`
  );
  const csv = 'transaction_id,date,purchased_from,total\n' + rows.join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="receiptap-expenses.csv"');
  res.send(csv);
});

module.exports = router;
