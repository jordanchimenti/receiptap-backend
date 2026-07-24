// routes/analytics.js
// One chart area, switchable between metrics via tabs (not multiple charts
// crammed onto one page) — more readable, and scales cleanly as more
// metrics get added later without a layout redesign.

const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function requireAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

function dayKey(date) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function buildDayRange(days) {
  const range = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    range.push(dayKey(d));
  }
  return range;
}

router.get('/dashboard/analytics', requireAuth, async (req, res) => {
  const days = parseInt(req.query.days, 10) || 30;
  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);

  const transactions = await prisma.transaction.findMany({
    where: { merchantId: req.session.merchantId, createdAt: { gte: since } },
    select: { total: true, createdAt: true, customerId: true },
    orderBy: { createdAt: 'asc' },
  });

  const dayLabels = buildDayRange(days);

  // --- Revenue over time: sum of totals per day, in dollars ---
  const revenueByDay = Object.fromEntries(dayLabels.map((d) => [d, 0]));
  for (const t of transactions) {
    const key = dayKey(t.createdAt);
    if (key in revenueByDay) revenueByDay[key] += t.total / 100;
  }
  const revenueData = dayLabels.map((d) => Math.round(revenueByDay[d] * 100) / 100);

  // --- New vs repeat customers per day ---
  // "New" = this is the customer's first-ever transaction with this merchant.
  // Need each customer's first-visit date across ALL of their history with
  // this merchant, not just within the selected window, so a customer whose
  // true first visit was outside the window still correctly counts as repeat.
  const customerIds = [...new Set(transactions.map((t) => t.customerId).filter(Boolean))];
  const firstVisits = await prisma.transaction.groupBy({
    by: ['customerId'],
    where: { merchantId: req.session.merchantId, customerId: { in: customerIds } },
    _min: { createdAt: true },
  });
  const firstVisitMap = new Map(firstVisits.map((f) => [f.customerId, dayKey(f._min.createdAt)]));

  const newByDay = Object.fromEntries(dayLabels.map((d) => [d, 0]));
  const repeatByDay = Object.fromEntries(dayLabels.map((d) => [d, 0]));
  for (const t of transactions) {
    if (!t.customerId) continue;
    const key = dayKey(t.createdAt);
    if (!(key in newByDay)) continue;
    if (firstVisitMap.get(t.customerId) === key) {
      newByDay[key] += 1;
    } else {
      repeatByDay[key] += 1;
    }
  }

  res.render('analytics', {
    days,
    dayLabels,
    revenueData,
    newData: dayLabels.map((d) => newByDay[d]),
    repeatData: dayLabels.map((d) => repeatByDay[d]),
  });
});

module.exports = router;
