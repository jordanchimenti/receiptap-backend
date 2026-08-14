// routes/oauth-square.js
// Merchant clicks "Connect Square" -> Square's login page -> back here.
// This is the ONE-TIME per-merchant handshake. Separate from webhooks.js,
// which is the ONGOING shared endpoint that receives sale events afterward.

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

function requireAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

// Sandbox apps (SQUARE_APP_ID starting with "sandbox-") only exist on
// Square's sandbox servers — sending a sandbox client_id to
// connect.squareup.com gets "Unable to find client by that client_id"
// since production has never heard of it.
const SQUARE_BASE_URL = process.env.SQUARE_APP_ID?.startsWith('sandbox-')
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com';

// Step 1: send the merchant to Square's own login/authorization page
router.get('/oauth/square/connect', requireAuth, (req, res) => {
  const redirectUri = `${req.protocol}://${req.get('host')}/oauth/square/callback`;
  const params = new URLSearchParams({
    client_id: process.env.SQUARE_APP_ID,
    scope: 'MERCHANT_PROFILE_READ PAYMENTS_READ ORDERS_READ',
    session: 'false',
    state: req.session.merchantId, // ties the callback back to the right merchant
    redirect_uri: redirectUri, // Square 400s with no body if this is missing entirely
  });
  res.redirect(`${SQUARE_BASE_URL}/oauth2/authorize?${params}`);
});

// Step 2: Square redirects back here with a temporary code
router.get('/oauth/square/callback', requireAuth, async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing authorization code from Square');

  // Must exactly match the redirect_uri used in the authorize request above.
  const redirectUri = `${req.protocol}://${req.get('host')}/oauth/square/callback`;

  const tokenResponse = await fetch(`${SQUARE_BASE_URL}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SQUARE_APP_ID,
      client_secret: process.env.SQUARE_APP_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    return res.status(400).send('Failed to connect Square account');
  }

  const { access_token, merchant_id: squareMerchantId } = await tokenResponse.json();

  await prisma.merchant.update({
    where: { id: req.session.merchantId },
    data: { squareMerchantId, squareAccessToken: access_token },
  });

  res.redirect('/dashboard/pos-setup');
});

// Step 3 (immediately after connecting): fetch their locations automatically.
// Also renders Clover's, Lightspeed's, and Shopify's connection state -- all
// three are a single location each (no picker needed there), so this just
// needs to know if each is connected at all, not fetch anything further.
router.get('/dashboard/pos-setup', requireAuth, async (req, res) => {
  const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
  const pucks = await prisma.puck.findMany({ where: { merchantId: merchant.id } });
  const cloverConnected = Boolean(merchant.cloverAccessToken);
  const cloverMerchantId = merchant.cloverMerchantId;
  const lightspeedConnected = Boolean(merchant.lightspeedAccessToken);
  const lightspeedDomainPrefix = merchant.lightspeedDomainPrefix;
  const shopifyConnected = Boolean(merchant.shopifyAccessToken);
  const shopifyShopDomain = merchant.shopifyShopDomain;

  if (!merchant.squareAccessToken) {
    return res.render('pos-setup', { connected: false, locations: [], pucks, cloverConnected, cloverMerchantId, lightspeedConnected, lightspeedDomainPrefix, shopifyConnected, shopifyShopDomain });
  }

  const locResponse = await fetch(`${SQUARE_BASE_URL}/v2/locations`, {
    headers: { Authorization: `Bearer ${merchant.squareAccessToken}` },
  });
  const { locations } = await locResponse.json();

  res.render('pos-setup', { connected: true, locations: locations || [], pucks, cloverConnected, cloverMerchantId, lightspeedConnected, lightspeedDomainPrefix, shopifyConnected, shopifyShopDomain });
});

// Assign a puck to a specific Square location/register
router.post('/dashboard/pos-setup/assign', requireAuth, async (req, res) => {
  const { puckId, locationId } = req.body;

  const puck = await prisma.puck.findUnique({ where: { id: puckId } });
  if (!puck || puck.merchantId !== req.session.merchantId) {
    return res.status(403).json({ error: 'Not your puck' });
  }

  await prisma.puck.update({ where: { id: puckId }, data: { posLocationId: locationId } });
  res.json({ success: true });
});

// For merchants with 2+ registers at one location: Square's Locations API
// doesn't expose individual lanes, so instead we look at REAL transactions
// that have already come in and group by the device_id Square reported.
// A merchant with only one register per location will just see one row here
// (or none, if their sales don't report a device_id at all — fine, the
// location-level fallback in webhooks.js handles that case automatically).
router.get('/dashboard/pos-setup/devices', requireAuth, async (req, res) => {
  const merchantId = req.session.merchantId;

  const recentTransactions = await prisma.transaction.findMany({
    where: { merchantId, posDeviceId: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 200, // recent window is enough to surface active devices
    select: { posLocationId: true, posDeviceId: true, createdAt: true },
  });

  const seen = new Map();
  for (const t of recentTransactions) {
    if (!seen.has(t.posDeviceId)) {
      seen.set(t.posDeviceId, { deviceId: t.posDeviceId, locationId: t.posLocationId, lastSeen: t.createdAt });
    }
  }

  const pucks = await prisma.puck.findMany({ where: { merchantId } });

  res.render('device-assignment', {
    devices: [...seen.values()],
    pucks,
  });
});

router.post('/dashboard/pos-setup/assign-device', requireAuth, async (req, res) => {
  const { puckId, deviceId, locationId } = req.body;

  const puck = await prisma.puck.findUnique({ where: { id: puckId } });
  if (!puck || puck.merchantId !== req.session.merchantId) {
    return res.status(403).json({ error: 'Not your puck' });
  }

  await prisma.puck.update({
    where: { id: puckId },
    data: { posDeviceId: deviceId, posLocationId: locationId },
  });
  res.json({ success: true });
});

module.exports = router;
