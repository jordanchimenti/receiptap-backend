// routes/merchant-dashboard.js
// "All receipts my business has issued" — merchant's own sales history

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { MERCHANT_AFFILIATE_RATE } = require('../services/affiliateRates');
const { hasCompleteAddress } = require('../services/easypostService');
const { getValidAccessToken } = require('../services/squareService');

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
            // Include the entire "to" day, not just midnight at its start
            ...(req.query.to ? { lte: new Date(new Date(req.query.to).setHours(23, 59, 59, 999)) } : {}),
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
      date: t.createdAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
    })),
    page,
    totalPages: Math.ceil(totalCount / pageSize),
    totalCount,
    filters: { from: req.query.from || '', to: req.query.to || '', search: req.query.search || '' },
  });
});

// Simple CSV export of the same filtered set — common merchant request (accounting/reconciliation)
router.get('/dashboard/receipts/export', requireAuth, async (req, res) => {
  const { from, to, search } = req.query;

  const where = {
    merchantId: req.session.merchantId,
    ...(from || to
      ? {
          createdAt: {
            ...(from ? { gte: new Date(from) } : {}),
            // Include the entire "to" day, not just midnight at its start
            ...(to ? { lte: new Date(new Date(to).setHours(23, 59, 59, 999)) } : {}),
          },
        }
      : {}),
    ...(search ? { lineItems: { path: '$[*].name', string_contains: search } } : {}),
  };

  const transactions = await prisma.transaction.findMany({
    where,
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

// Shared by GET /dashboard/receipts-hub and GET /account/business/receipts
// (the wallet's dark reskin) -- see routes/account-business.js. Keeping the
// query/shaping logic here means both pages read the exact same numbers,
// never two independently-derived versions of "your receipts."
//
// page/pageSize are optional -- the real dashboard doesn't pass either
// (page defaults to 1, pageSize to 25), which reproduces exactly what this
// function returned before pagination existed: the most recent 25 rows,
// no page info. The wallet's Receipts page passes both to page 5 at a time.
async function computeReceiptsHubData(merchantId, { from, to, tab, page, pageSize = 25 } = {}) {
  const currentPage = Math.max(1, parseInt(page, 10) || 1);
  const activeTab = tab === 'merchant' ? 'merchant' : 'customer';

  const dateRange =
    from || to
      ? {
          createdAt: {
            ...(from ? { gte: new Date(from) } : {}),
            // Include the entire "to" day, not just midnight at its start
            ...(to ? { lte: new Date(new Date(to).setHours(23, 59, 59, 999)) } : {}),
          },
        }
      : {};

  const [issuedCount, receivedCount] = await Promise.all([
    prisma.transaction.count({ where: { merchantId, ...dateRange } }),
    prisma.transaction.count({ where: { collectedByMerchantId: merchantId, ...dateRange } }),
  ]);

  // Customer Receipts tab: a single ordered source -- a normal skip/take
  // lands on the right page.
  const customerTotalPages = Math.max(1, Math.ceil(issuedCount / pageSize));
  const issuedPage = await prisma.transaction.findMany({
    where: { merchantId, ...dateRange },
    orderBy: { createdAt: 'desc' },
    skip: (currentPage - 1) * pageSize,
    take: pageSize,
  });
  const customerReceipts = issuedPage.map((t) => ({
    ...t,
    total: (t.total / 100).toFixed(2),
    date: t.createdAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
  }));

  // Merchant Receipts = this business's own copy of every sale it made
  // (for its records -- same transaction as the Customer Receipts tab, just
  // a merchant-facing copy), PLUS anything this business itself bought at
  // another ReceipTap merchant. Two sources merged by date, so a plain
  // skip/take on either one alone can't land on the right window -- fetch
  // enough of both (everything through the end of the requested page) and
  // slice the merged, re-sorted list instead.
  const merchantTotalPages = Math.max(1, Math.ceil((issuedCount + receivedCount) / pageSize));
  const throughThisPage = currentPage * pageSize;
  const [issuedForMerchantTab, received] = await Promise.all([
    prisma.transaction.findMany({
      where: { merchantId, ...dateRange },
      orderBy: { createdAt: 'desc' },
      take: throughThisPage,
    }),
    prisma.transaction.findMany({
      where: { collectedByMerchantId: merchantId, ...dateRange },
      include: { merchant: true },
      orderBy: { createdAt: 'desc' },
      take: throughThisPage,
    }),
  ]);
  const merchantReceipts = [
    ...issuedForMerchantTab.map((t) => ({ ...t, kind: 'own-sale' })),
    ...received.map((t) => ({ ...t, soldByName: t.merchant.businessName, kind: 'purchased' })),
  ]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice((currentPage - 1) * pageSize, currentPage * pageSize)
    .map((t) => ({
      ...t,
      total: (t.total / 100).toFixed(2),
      date: t.createdAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
    }));

  return {
    customerReceipts,
    customerTotalPages,
    merchantReceipts,
    merchantTotalPages,
    filters: { from: from || '', to: to || '' },
    activeTab,
    page: currentPage,
  };
}

// GET /dashboard/receipts-hub?from=&to=&tab= — combined view: both collections,
// tab-switched client-side, both filterable by the same date range
router.get('/dashboard/receipts-hub', requireAuth, async (req, res) => {
  const data = await computeReceiptsHubData(req.session.merchantId, {
    from: req.query.from,
    to: req.query.to,
    tab: req.query.tab,
  });
  res.render('receipts-hub', data);
});

// ---------------------------------------------------------------------------
// GET /dashboard — Overview. Every number here is computed from real rows;
// nothing on this page is a placeholder. Shared with GET /account/business
// (routes/account-business.js) the same way computeReceiptsHubData is above.
// ---------------------------------------------------------------------------
async function computeOverviewData(merchantId) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d7 = new Date(Date.now() - 7 * 864e5);
  const d14 = new Date(Date.now() - 14 * 864e5);

  const [merchant, pucks, recent, allTx, last7, prev7, receiptTheme] = await Promise.all([
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
    // Only existence matters here (the "customize your receipt" setup-progress
    // step below) -- the real theme content is read separately, where it's
    // actually used (routes/theme-settings.js).
    prisma.receiptTheme.findUnique({ where: { merchantId } }),
  ]);

  const monthCents = allTx
    .filter((t) => t.createdAt >= monthStart)
    .reduce((s, t) => s + t.total, 0);
  const todayTx = allTx.filter((t) => t.createdAt >= todayStart);
  const todayCents = todayTx.reduce((s, t) => s + t.total, 0);
  const customerCount = new Set(allTx.filter((t) => t.customerId).map((t) => t.customerId)).size;

  // Setup progress -- shown on the wallet's dark Overview reskin
  // (views/business-overview.ejs) as a checklist. Every step here is
  // derived from real account state, never a made-up tracker: an account
  // always exists by the time this runs, billing is "added" once a trial
  // has actually been started (subscriptionStatus moves off INCOMPLETE),
  // a ReceipTap is "set up" once at least one has been claimed to this
  // account, the receipt is "customized" once a ReceiptTheme row exists,
  // and the Partner Program step is done once the receipt banner is
  // actually switched on (ReceiptTheme.showPartnerProgram) -- that's the
  // thing that starts earning, not merely visiting the page. No "connect
  // to WiFi" step -- ReceipTap's pucks are passive NFC with no power or
  // radio of their own (see CLAUDE.md), so unlike a WiFi-connected device
  // there's nothing to "connect" before tapping it.
  const setupSteps = {
    accountCreated: true,
    // Done once a full mailing address is on file AND a tax registration
    // number is entered -- the two things every receipt this merchant
    // issues needs to actually support a customer's CRA input tax credit or
    // IRS deduction claim (see lib/receiptMissingFields.js). Both live on
    // the same Business Settings page, so one step covers both rather than
    // splitting into two a merchant would fill in together anyway.
    businessProfileComplete: hasCompleteAddress(merchant) && Boolean(receiptTheme && receiptTheme.gstHstNumber),
    billingAdded: merchant.subscriptionStatus !== 'INCOMPLETE',
    puckSetUp: pucks.length > 0,
    receiptCustomized: Boolean(receiptTheme),
    partnerProgramOn: Boolean(receiptTheme && receiptTheme.showPartnerProgram),
    // Set the first time this merchant opens the dashboard from their home
    // screen (the browser reports display-mode: standalone) -- observed state,
    // not a "did they visit the page" flag.
    homeScreenAdded: Boolean(merchant.homeScreenAddedAt),
  };
  const setupDoneCount = Object.values(setupSteps).filter(Boolean).length;
  // Divide by the actual step count so adding a step can't leave the
  // percentage silently wrong (it was hardcoded to 4 before this one).
  const setup = {
    ...setupSteps,
    percent: Math.round((setupDoneCount / Object.keys(setupSteps).length) * 100),
  };

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

  // The "Get started" card under Today's total. Three real states, in the
  // order a merchant actually has to do them -- and every one is read from
  // account state, never a visited-the-page flag:
  //   claim a ReceipTap -> connect a POS -> link the ReceipTap to a register.
  // The third step is the one that's easy to miss: a claimed puck attached to
  // a connected POS still issues nothing until it's pointed at a register.
  // The whole card disappears once all three are done.
  const posConnected = Boolean(
    merchant.squareAccessToken ||
    merchant.cloverAccessToken ||
    merchant.lightspeedAccessToken ||
    merchant.shopifyAccessToken
  );
  const getStarted = {
    claimed: pucks.length > 0,
    posConnected,
    linked: linkedCount > 0,
  };
  getStarted.complete = getStarted.claimed && getStarted.posConnected && getStarted.linked;
  // Which step the primary button should drop them into -- the first one
  // that isn't done yet.
  getStarted.nextHref = !getStarted.claimed
    ? '/account/business/claim'
    : '/account/business/pos';

  return {
    merchant,
    merchantAffiliateRate: MERCHANT_AFFILIATE_RATE,
    getStarted,
    stats: {
      receipts: allTx.length,
      receiptsDelta,
      pucksActive: pucks.length,
      pucksLinked: linkedCount,
      monthRevenue: (monthCents / 100).toFixed(2),
      monthLabel: now.toLocaleDateString('en-US', { month: 'long' }),
      customers: customerCount,
      todayRevenue: (todayCents / 100).toFixed(2),
      todayReceipts: todayTx.length,
    },
    setup,
    // Carries both shapes: the Dashboard shows the four summary tiles, and the
    // ReceipTaps page shows the linked/pairing/needs-linking breakdown. Same
    // counts either way -- they're derived here once rather than each page
    // doing its own arithmetic and drifting.
    puckStatus: {
      linked: linkedCount,
      pairing: pairingCount,
      setup: setupCount,
      total: puckRows.length,
      activatedThisMonth: puckRows.filter((p) => p.claimedAt && p.claimedAt >= monthStart).length,
      monthLabel: now.toLocaleDateString('en-US', { month: 'long' }),
    },
    pucks: puckRows.slice(0, 6),
    recent: recent.map((t) => ({
      id: t.id,
      who: t.customer ? t.customer.email : 'Not saved to a wallet',
      identified: Boolean(t.customer),
      total: (t.total / 100).toFixed(2),
      when: timeAgo(t.createdAt),
      method: t.paymentMethod || null,
    })),
  };
}

router.get('/dashboard', requireAuth, async (req, res) => {
  res.render('dashboard-overview', await computeOverviewData(req.session.merchantId));
});

// Resolves real Square location names for a merchant's own posLocationIds.
// One API call per request regardless of row count. Never throws — a
// disconnected/unreachable Square account just falls back to raw IDs
// rather than breaking the page.
async function resolveLocationNames(merchant, locationIds) {
  const names = {};
  if (!merchant.squareAccessToken || locationIds.length === 0) return names;
  try {
    // Never reads merchant.squareAccessToken directly -- see that field's
    // schema comment. A dead connection throws here the same way an
    // unreachable Square would, caught by the same catch below.
    const accessToken = await getValidAccessToken(merchant);
    const resp = await fetch('https://connect.squareup.com/v2/locations', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return names;
    const { locations } = await resp.json();
    for (const loc of locations || []) names[loc.id] = loc.name;
  } catch (_err) {
    // Square unreachable, or the connection is dead -- degrade to raw IDs, never 500
  }
  return names;
}

function displayLocation(locationId, names) {
  if (!locationId) return 'Unassigned';
  return names[locationId] || locationId;
}

// GET /dashboard/pucks — every ReceipTap on this account: stats, search/filter,
// a paginated table, and a details panel for whichever one is selected.
// Shared with GET /account/business/pucks the same way computeOverviewData is above.
async function computePucksData(merchantId, query = {}) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [merchant, pucks] = await Promise.all([
    prisma.merchant.findUnique({ where: { id: merchantId } }),
    prisma.puck.findMany({ where: { merchantId }, orderBy: { claimedAt: 'asc' } }),
  ]);

  const ASSIGN_WINDOW_MS = 15 * 60 * 1000;
  const isLinked = (p) => Boolean(p.posLocationId || p.posDeviceId);
  // NOTE: awaitingSaleAssignment does not exist in prisma/schema.prisma and is
  // never written anywhere -- this always evaluates false today. Pre-existing
  // gap, intentionally not fixed as part of this page's redesign.
  const isPairing = (p) =>
    Boolean(p.awaitingSaleAssignment && new Date(p.awaitingSaleAssignment) > new Date(Date.now() - ASSIGN_WINDOW_MS));

  const linkedCount = pucks.filter(isLinked).length;
  const pairingCount = pucks.filter((p) => !isLinked(p) && isPairing(p)).length;
  const needsLinkingCount = pucks.length - linkedCount - pairingCount;
  const activatedThisMonth = pucks.filter((p) => p.claimedAt && p.claimedAt >= monthStart).length;

  const stats = {
    total: pucks.length,
    linked: linkedCount,
    // Already counted above for needsLinking; now surfaced too, because this
    // page shows the three-way status breakdown.
    pairing: pairingCount,
    needsLinking: needsLinkingCount,
    activatedThisMonth,
    monthLabel: now.toLocaleDateString('en-US', { month: 'long' }),
  };

  // --- Tabs: All ReceipTaps / By Location ------------------------------
  const tab = query.tab === 'location' ? 'location' : 'list';

  // --- Search + filter (status is derived, not a real column, so this
  // filters/paginates in JS rather than pushing status into a Prisma where) --
  const page = parseInt(query.page, 10) || 1;
  const pageSize = 25;
  const search = (query.search || '').trim().toLowerCase();
  const locationFilter = query.location || '';
  const statusFilter = query.status || '';

  const filtered = pucks.filter((p) => {
    if (search && !p.id.toLowerCase().includes(search) && !p.claimCode.toLowerCase().includes(search)) return false;
    if (locationFilter === '__unassigned__' && p.posLocationId) return false;
    if (locationFilter && locationFilter !== '__unassigned__' && p.posLocationId !== locationFilter) return false;
    if (statusFilter === 'linked' && !isLinked(p)) return false;
    if (statusFilter === 'pairing' && !(!isLinked(p) && isPairing(p))) return false;
    if (statusFilter === 'needsLinking' && (isLinked(p) || isPairing(p))) return false;
    return true;
  });
  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);

  const locationIds = [...new Set(pucks.map((p) => p.posLocationId).filter(Boolean))];
  const names = await resolveLocationNames(merchant, locationIds);
  const hasUnassigned = pucks.some((p) => !p.posLocationId);

  // --- By-Location grouping (only computed/used when that tab is active) --
  const grouped = {};
  if (tab === 'location') {
    for (const p of filtered) {
      const key = p.posLocationId || '__unassigned__';
      (grouped[key] ||= []).push(p);
    }
  }

  // --- Master-detail: whichever puck is selected, scoped to this merchant --
  const selectedId = query.selected || (pageRows[0] && pageRows[0].id) || null;
  const selectedPuck = selectedId
    ? await prisma.puck.findFirst({ where: { id: selectedId, merchantId } })
    : null;

  const recentActivations = await prisma.puck.findMany({
    where: { merchantId, claimedAt: { not: null } },
    orderBy: { claimedAt: 'desc' },
    take: 8,
  });

  const toRow = (p) => ({
    id: p.id,
    linked: isLinked(p),
    pairing: !isLinked(p) && isPairing(p),
    location: displayLocation(p.posLocationId, names),
    connectedTo: p.posDeviceId || 'Not linked yet',
    claimedAt: p.claimedAt,
  });

  return {
    merchant,
    stats,
    tab,
    filters: { search: query.search || '', location: locationFilter, status: statusFilter },
    locationOptions: locationIds.map((id) => ({ value: id, label: displayLocation(id, names) })),
    hasUnassigned,
    pucks: pageRows.map(toRow),
    grouped: Object.fromEntries(
      Object.entries(grouped).map(([key, rows]) => [
        key,
        { label: key === '__unassigned__' ? 'Unassigned' : displayLocation(key, names), rows: rows.map(toRow) },
      ])
    ),
    page,
    totalPages,
    totalCount,
    selectedPuck: selectedPuck
      ? {
          ...toRow(selectedPuck),
          claimedAtLabel: selectedPuck.claimedAt
            ? new Date(selectedPuck.claimedAt).toLocaleDateString('en-US', { dateStyle: 'medium' })
            : 'Not yet activated',
        }
      : null,
    recentActivations: recentActivations.map((p) => ({ id: p.id, when: timeAgo(p.claimedAt) })),
  };
}

router.get('/dashboard/pucks', requireAuth, async (req, res) => {
  res.render('pucks-list', await computePucksData(req.session.merchantId, req.query));
});

// POST /dashboard/pucks/:id/unassign — clears a puck's register/location
// assignment so it can be re-linked. Ownership check mirrors the pattern
// already used in routes/oauth-square.js's assign endpoints.
router.post('/dashboard/pucks/:id/unassign', requireAuth, async (req, res) => {
  const puck = await prisma.puck.findUnique({ where: { id: req.params.id } });
  if (!puck || puck.merchantId !== req.session.merchantId) {
    return res.status(403).json({ error: 'Not your puck' });
  }
  await prisma.puck.update({ where: { id: puck.id }, data: { posLocationId: null, posDeviceId: null } });
  res.redirect(`/dashboard/pucks?selected=${puck.id}`);
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
// Exposed for routes/account-business.js -- see the comment on each
// function above for why these are shared rather than re-derived.
module.exports.computeOverviewData = computeOverviewData;
module.exports.computeReceiptsHubData = computeReceiptsHubData;
module.exports.computePucksData = computePucksData;
