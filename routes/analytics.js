// routes/analytics.js
// Analytics dashboard: stat cards, receipts-over-time (vs previous period),
// receipts by POS source, weekly customer growth, and a polling activity feed.
// Every number here is computed from real Transaction/Customer rows.

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

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

// Percent change vs. a prior-period baseline. Null when there's nothing to
// compare against — never render a fabricated percent off a zero baseline.
function pctDelta(cur, prev) {
  return prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null;
}

const POS_LABELS = { square: 'Square', shopify: 'Shopify', clover: 'Clover', toast: 'Toast' };
const POS_COLORS = { square: '#056BFE', shopify: '#5B57D8', clover: '#17915C', toast: '#C97A2B' };

// Recent receipts + recently-first-seen customers, merged and sorted by
// recency. Shared by the initial page render and the polling endpoint below
// so the two never drift out of sync with each other.
async function getRecentActivity(merchantId, limit = 10) {
  const [recentTx, newCustomerVisits] = await Promise.all([
    prisma.transaction.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.transaction.groupBy({
      by: ['customerId'],
      where: { merchantId, customerId: { not: null } },
      _min: { createdAt: true },
      orderBy: { _min: { createdAt: 'desc' } },
      take: limit,
    }),
  ]);

  const custs = await prisma.customer.findMany({
    where: { id: { in: newCustomerVisits.map((v) => v.customerId) } },
  });
  const custMap = new Map(custs.map((c) => [c.id, c]));

  const receiptEvents = recentTx.map((t) => ({
    text: t.customerId
      ? `Receipt claimed — $${(t.total / 100).toFixed(2)}`
      : `Receipt issued — $${(t.total / 100).toFixed(2)}`,
    at: t.createdAt,
  }));
  const customerEvents = newCustomerVisits.map((v) => ({
    text: `New customer: ${custMap.get(v.customerId)?.email || 'unknown'}`,
    at: v._min.createdAt,
  }));

  return [...receiptEvents, ...customerEvents]
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((e) => ({ text: e.text, when: timeAgo(e.at) }));
}

router.get('/dashboard/analytics', requireAuth, async (req, res) => {
  const merchantId = req.session.merchantId;
  const days = [7, 30, 90].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 30;

  const now = new Date();
  const since = new Date(now);
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);
  const prevSince = new Date(since);
  prevSince.setDate(prevSince.getDate() - days);

  const [merchant, rows] = await Promise.all([
    prisma.merchant.findUnique({ where: { id: merchantId } }),
    prisma.transaction.findMany({
      where: { merchantId, createdAt: { gte: prevSince } },
      select: { total: true, createdAt: true, customerId: true, posProvider: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const curRows = rows.filter((t) => t.createdAt >= since);
  const prevRows = rows.filter((t) => t.createdAt < since);

  // --- Stat cards ------------------------------------------------------
  const totalReceipts = curRows.length;
  const prevReceipts = prevRows.length;

  const claimedRows = curRows.filter((t) => t.customerId);
  const prevClaimedRows = prevRows.filter((t) => t.customerId);
  const receiptsClaimed = claimedRows.length;

  const totalCustomers = new Set(claimedRows.map((t) => t.customerId)).size;
  const prevTotalCustomers = new Set(prevClaimedRows.map((t) => t.customerId)).size;

  const totalCents = curRows.reduce((s, t) => s + t.total, 0);
  const prevCents = prevRows.reduce((s, t) => s + t.total, 0);
  const avgSpend = totalReceipts ? totalCents / totalReceipts / 100 : 0;
  const prevAvgSpend = prevReceipts ? prevCents / prevReceipts / 100 : 0;

  const claimRate = totalReceipts ? (receiptsClaimed / totalReceipts) * 100 : 0;
  const prevClaimRate = prevReceipts ? (prevClaimedRows.length / prevReceipts) * 100 : null;

  const stats = {
    totalReceipts,
    totalReceiptsDelta: pctDelta(totalReceipts, prevReceipts),
    totalCustomers,
    totalCustomersDelta: pctDelta(totalCustomers, prevTotalCustomers),
    receiptsClaimed,
    receiptsClaimedDelta: pctDelta(receiptsClaimed, prevClaimedRows.length),
    avgSpend: avgSpend.toFixed(2),
    avgSpendDelta: prevAvgSpend > 0 ? Math.round(((avgSpend - prevAvgSpend) / prevAvgSpend) * 100) : null,
    claimRate: Math.round(claimRate),
    claimRateDelta: prevClaimRate !== null ? Math.round(claimRate - prevClaimRate) : null,
  };

  // --- Receipts over time: this period vs previous period, by day ------
  const dayLabels = buildDayRange(days);
  const curByDay = new Array(days).fill(0);
  const prevByDay = new Array(days).fill(0);
  for (const t of curRows) {
    const idx = Math.min(days - 1, Math.max(0, Math.floor((t.createdAt - since) / 864e5)));
    curByDay[idx] += 1;
  }
  for (const t of prevRows) {
    const idx = Math.min(days - 1, Math.max(0, Math.floor((t.createdAt - prevSince) / 864e5)));
    prevByDay[idx] += 1;
  }

  // --- Receipts by POS source ------------------------------------------
  const posGroups = await prisma.transaction.groupBy({
    by: ['posProvider'],
    where: { merchantId, createdAt: { gte: since } },
    _count: { _all: true },
  });
  const posBreakdown = posGroups
    .map((g) => ({
      label: POS_LABELS[g.posProvider] || g.posProvider,
      count: g._count._all,
      color: POS_COLORS[g.posProvider] || '#B6BCCE',
    }))
    .filter((p) => p.count > 0)
    .sort((a, b) => b.count - a.count);

  // --- Customer growth: new customers per week, this period ------------
  const curCustomerIds = [...new Set(curRows.map((t) => t.customerId).filter(Boolean))];
  const firstVisits = curCustomerIds.length
    ? await prisma.transaction.groupBy({
        by: ['customerId'],
        where: { merchantId, customerId: { in: curCustomerIds } },
        _min: { createdAt: true },
      })
    : [];
  const firstVisitMap = new Map(firstVisits.map((f) => [f.customerId, f._min.createdAt]));

  const weekCount = Math.ceil(days / 7);
  const weekBuckets = new Array(weekCount).fill(0);
  for (const id of curCustomerIds) {
    const fv = firstVisitMap.get(id);
    if (fv && fv >= since) {
      const wk = Math.min(weekCount - 1, Math.floor((fv - since) / (7 * 864e5)));
      weekBuckets[wk] += 1;
    }
  }
  const weekLabels = Array.from({ length: weekCount }, (_, i) => {
    const start = new Date(since);
    start.setDate(start.getDate() + i * 7);
    return start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  const activity = await getRecentActivity(merchantId);

  res.render('analytics', {
    merchant,
    days,
    dayLabels,
    curByDay,
    prevByDay,
    stats,
    posBreakdown,
    weekLabels,
    weekBuckets,
    activity,
  });
});

// Polled every ~20s by the page's client-side script. Scoped strictly to the
// signed-in merchant via the session — never trust a merchant ID from the
// request itself. Sits under the same /dashboard mount order as the page
// route, so it inherits the subscription gate already wired in server.js.
router.get('/dashboard/analytics/activity', requireAuth, async (req, res) => {
  const events = await getRecentActivity(req.session.merchantId);
  res.set('Cache-Control', 'no-store');
  res.json({ events });
});

// CSV export scoped to whatever date range is currently on screen (unlike
// the all-time exports elsewhere in the app, this one matches what the
// merchant is actually looking at).
router.get('/dashboard/analytics/export', requireAuth, async (req, res) => {
  const days = [7, 30, 90].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 30;
  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);

  const transactions = await prisma.transaction.findMany({
    where: { merchantId: req.session.merchantId, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
  });

  const rows = transactions.map(
    (t) =>
      `${t.id},${t.createdAt.toISOString()},${(t.total / 100).toFixed(2)},${t.paymentMethod || ''},${t.posProvider},${t.customerId ? 'claimed' : 'unclaimed'}`
  );
  const csv = 'transaction_id,date,total,payment_method,pos_provider,claim_status\n' + rows.join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="receiptap-analytics-${days}d.csv"`);
  res.send(csv);
});

module.exports = router;
