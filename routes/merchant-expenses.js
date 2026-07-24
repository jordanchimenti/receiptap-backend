// routes/merchant-expenses.js
// "Receipts my business has RECEIVED" — the flip side of merchant-dashboard.js.
// A merchant account can also act as a purchaser at another ReceipTap merchant
// (e.g. buying supplies) and save that receipt into their own expense records.

const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function requireAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

// Called from the receipt page when a logged-in MERCHANT (not a consumer
// customer) taps "Save as Business Expense" instead of the customer wallet button
router.post('/receipt/:transactionId/save-expense', requireAuth, async (req, res) => {
  const transaction = await prisma.transaction.findUnique({
    where: { id: req.params.transactionId },
  });
  if (!transaction) return res.status(404).json({ error: 'Receipt not found' });

  // A merchant shouldn't file their own issued receipt as their own expense
  if (transaction.merchantId === req.session.merchantId) {
    return res.status(400).json({ error: 'This is a receipt your business issued, not received' });
  }

  await prisma.transaction.update({
    where: { id: transaction.id },
    data: { collectedByMerchantId: req.session.merchantId },
  });

  res.json({ success: true });
});

// GET /dashboard/expenses — everything this merchant has bought elsewhere and saved
router.get('/dashboard/expenses', requireAuth, async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const pageSize = 25;

  const where = { collectedByMerchantId: req.session.merchantId };

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
  });
});

// Same idea as the sales export — useful for expense tracking / tax prep
router.get('/dashboard/expenses/export', requireAuth, async (req, res) => {
  const transactions = await prisma.transaction.findMany({
    where: { collectedByMerchantId: req.session.merchantId },
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
