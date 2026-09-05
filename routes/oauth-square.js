// routes/oauth-square.js
// Merchant clicks "Connect Square" -> Square's login page -> back here.
// This is the ONE-TIME per-merchant handshake. Separate from webhooks.js,
// which is the ONGOING shared endpoint that receives sale events afterward.

const express = require('express');
const { getBaseUrl } = require('../lib/baseUrl');
const router = express.Router();
const prisma = require('../lib/prisma');
const { posReturnPath } = require('../lib/posReturnPath');
const { getValidAccessToken } = require('../services/squareService');

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
  // OAuth redirect URIs must EXACTLY match a value registered with the provider,
  // so there has to be exactly one of them. This used to be built from
  // req.get('host'), which made it different on localhost, on a tunnel and in
  // production -- three URIs to register, one of which (http://localhost) a
  // production Square app rejects outright with
  // "Invalid value for parameter `redirect_uri`".
  //
  // getBaseUrl pins it to APP_BASE_URL when that is set, so there is a single
  // URI per provider to register. It still falls back to the request host when
  // APP_BASE_URL is unset, which keeps a bare local checkout working.
  const redirectUri = `${getBaseUrl(req)}/oauth/square/callback`;
  const params = new URLSearchParams({
    client_id: process.env.SQUARE_APP_ID,
    scope: 'MERCHANT_PROFILE_READ PAYMENTS_READ ORDERS_READ',
    session: 'false',
    // Round-tripped back on the callback below to know where to send the
    // merchant afterward (real dashboard vs. the wallet) -- requireAuth on
    // the callback already gives us req.session.merchantId, so this no
    // longer needs to carry the merchant's identity the way the comment
    // used to imply.
    state: posReturnPath(req.query.next),
    redirect_uri: redirectUri, // Square 400s with no body if this is missing entirely
  });
  res.redirect(`${SQUARE_BASE_URL}/oauth2/authorize?${params}`);
});

// Step 2: Square redirects back here with a temporary code
router.get('/oauth/square/callback', requireAuth, async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('Missing authorization code from Square');

  // Must exactly match the redirect_uri used in the authorize request above.
  const redirectUri = `${getBaseUrl(req)}/oauth/square/callback`;

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

  // expires_at is an ISO timestamp -- see services/squareService.js's
  // getValidAccessToken, the only thing that should ever read these three
  // fields back out. refresh_token is what makes that possible; it used to
  // be discarded here entirely, which is why the access token alone was
  // wrongly assumed not to expire.
  const { access_token, refresh_token, expires_at, merchant_id: squareMerchantId } = await tokenResponse.json();

  await prisma.merchant.update({
    where: { id: req.session.merchantId },
    data: {
      squareMerchantId,
      squareAccessToken: access_token,
      squareRefreshToken: refresh_token,
      squareAccessTokenExpiresAt: new Date(expires_at),
    },
  });

  res.redirect(posReturnPath(state));
});

// Shared by GET /dashboard/pos-setup and GET /account/business/pos (the
// wallet's dark reskin) -- see routes/account-business.js. Fetches Square's
// locations live (needs a fresh API call, not just stored data), plus
// Clover's/Lightspeed's/Shopify's connection state -- all three are a
// single location each (no picker needed there), so this just needs to
// know if each is connected at all, not fetch anything further.
async function computePosSetupData(merchantId) {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
  const pucks = await prisma.puck.findMany({ where: { merchantId: merchant.id } });
  const cloverConnected = Boolean(merchant.cloverAccessToken);
  const cloverMerchantId = merchant.cloverMerchantId;
  const lightspeedConnected = Boolean(merchant.lightspeedAccessToken);
  const lightspeedDomainPrefix = merchant.lightspeedDomainPrefix;
  const shopifyConnected = Boolean(merchant.shopifyAccessToken);
  const shopifyShopDomain = merchant.shopifyShopDomain;

  if (!merchant.squareAccessToken) {
    return { connected: false, locations: [], pucks, cloverConnected, cloverMerchantId, lightspeedConnected, lightspeedDomainPrefix, shopifyConnected, shopifyShopDomain };
  }

  // Never reads merchant.squareAccessToken directly -- see that field's
  // schema comment. A dead connection (revoked, or connected before this
  // fix and missing a refresh token) degrades to "not connected" here
  // rather than throwing, same as the missing-token branch above; the
  // reconnect notification already fired inside getValidAccessToken.
  let accessToken;
  try {
    accessToken = await getValidAccessToken(merchant);
  } catch (err) {
    return { connected: false, locations: [], pucks, cloverConnected, cloverMerchantId, lightspeedConnected, lightspeedDomainPrefix, shopifyConnected, shopifyShopDomain };
  }

  const locResponse = await fetch(`${SQUARE_BASE_URL}/v2/locations`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const { locations } = await locResponse.json();

  return { connected: true, locations: locations || [], pucks, cloverConnected, cloverMerchantId, lightspeedConnected, lightspeedDomainPrefix, shopifyConnected, shopifyShopDomain };
}

router.get('/dashboard/pos-setup', requireAuth, async (req, res) => {
  res.render('pos-setup', await computePosSetupData(req.session.merchantId));
});

// Static per-provider walkthroughs for connecting + assigning a puck. Not
// provider-specific code, just co-located with the other
// /dashboard/pos-setup/* routes rather than a route file of its own for a
// handful of static pages. One template (views/pos-setup-guide.ejs) driven
// by this data rather than four near-identical EJS files.
//
// Every step is { text, image }, image optional — a screenshot with a red
// callout baked into the pixels, or null for a step with nothing to
// screenshot (e.g. a physical action like tapping the puck to a phone).
//
// GETTING_STARTED_STEPS covers the part of onboarding that's identical for
// every provider (sign in, start the trial, tap the puck, enter the
// activation code) and gets prepended to each provider's own steps below,
// rather than repeated once per provider.
const GETTING_STARTED_STEPS = [
  {
    text: 'Sign in to your ReceipTap account — or <a href="/signup">create one</a> if you\'re new. Do this <strong>before</strong> tapping the puck, so you land back in the right place afterward instead of your dashboard home.',
    image: '/images/pos-guides/getting-started/01-create-account.png',
  },
  {
    text: "If this is a brand-new account, you'll be asked to start your 30-day free trial before you can reach anything else — a card is required, but you won't be charged until the trial ends. Go to <a href=\"{{billingPath}}\">Billing</a> to start it.",
    image: '/images/pos-guides/getting-started/02-start-trial.png',
  },
  {
    text: 'Tap and hold your phone to the ReceipTap puck.',
    image: null,
  },
  {
    text: "Enter the 6-character activation code printed on the insert card that came in the box, then click <strong>Activate</strong>. If you see a red \"Incorrect activation code\" message, double-check what you typed against the card — it's case-insensitive, so that's not the issue.",
    image: '/images/pos-guides/getting-started/04-enter-claim-code.png',
  },
  {
    text: "You'll land automatically on the POS connection page — that's where the steps below pick up.",
    image: null,
  },
];

const POS_SETUP_GUIDES = {
  square: {
    providerName: 'Square',
    steps: [
      { text: 'On the POS connection page, click <strong>Connect Square</strong>.', image: '/images/pos-guides/square/01-connect-button.png' },
      { text: 'Log into your Square account when Square asks.', image: '/images/pos-guides/square/02-square-login.jpg' },
      { text: "Click <strong>Allow</strong> to approve ReceipTap's access to your Square account.", image: null },
      { text: "You'll land back on ReceipTap — a Square connection covers one store, so there's no location list to pick from.", image: '/images/pos-guides/square/03-connected-badge.png' },
      { text: 'Pick the puck at your register from the dropdown to link it.', image: '/images/pos-guides/square/04-assign-puck.jpg' },
    ],
    note: 'Have more than one register? ReceipTap can tell them apart once real sales start coming in — check the register list on the POS connection page after your first few sales.',
  },
  clover: {
    providerName: 'Clover',
    steps: [
      { text: 'On the POS connection page, click <strong>Connect Clover</strong>.', image: null },
      { text: 'Log into your Clover account when Clover asks.', image: '/images/pos-guides/clover/02-clover-login.jpg' },
      { text: "Click <strong>Allow</strong> to approve ReceipTap's access to your Clover account.", image: null },
      { text: "You'll land back on ReceipTap — a Clover connection covers one store, so there's no location list to pick from.", image: null },
      { text: 'Pick the puck at your register from the dropdown to link it.', image: '/images/pos-guides/clover/01-assign-puck.png' },
    ],
  },
  lightspeed: {
    providerName: 'Lightspeed',
    steps: [
      { text: 'On the POS connection page, click <strong>Connect Lightspeed</strong>.', image: null },
      { text: 'Log into your Lightspeed Retail (X-Series) account when Lightspeed asks.', image: '/images/pos-guides/lightspeed/02-lightspeed-login.jpg' },
      { text: "Click <strong>Allow</strong> to approve ReceipTap's access to your Lightspeed account.", image: null },
      { text: "You'll land back on ReceipTap — a Lightspeed connection covers one store, so there's no location list to pick from.", image: null },
      { text: 'Pick the puck at your register from the dropdown to link it.', image: '/images/pos-guides/lightspeed/01-assign-puck.png' },
    ],
  },
  shopify: {
    providerName: 'Shopify',
    steps: [
      { text: "On the POS connection page, type your store's address into the Shopify field, in the form <code>yourstorename.myshopify.com</code>.", image: '/images/pos-guides/shopify/01-domain-input.png' },
      { text: 'Click <strong>Connect Shopify</strong>.', image: null },
      { text: 'You\'ll be sent to Shopify\'s own "Install app" screen — click <strong>Install</strong> to approve it.', image: null },
      { text: "You'll land back on ReceipTap — a Shopify connection covers one store, so there's no location list to pick from.", image: null },
      { text: 'Pick the puck at your register from the dropdown to link it.', image: '/images/pos-guides/shopify/02-assign-puck.png' },
    ],
    note: 'Only in-person sales rung through Shopify POS generate a ReceipTap receipt — online store orders are skipped automatically.',
  },
};

// Searchable index of every provider's guide, reachable from the sidebar --
// pulls the list straight from POS_SETUP_GUIDES rather than a separate
// hardcoded list, so a future fifth provider only has to be added once.
// Shared by GET /dashboard/pos-setup/guides and GET /account/business/pos/guides
// (the wallet's dark reskin) -- see routes/account-business.js.
function getGuideProviders() {
  return Object.keys(POS_SETUP_GUIDES).map((key) => ({
    key,
    providerName: POS_SETUP_GUIDES[key].providerName,
  }));
}

// Shared by GET /dashboard/pos-setup/guide/:provider and
// GET /account/business/pos/guide/:provider. Returns null for an unknown
// provider key so each thin route can 404 itself.
// billingPath: the guide is served on both surfaces, so the "go start your
// trial" link has to resolve to the Billing page of whichever dashboard the
// merchant is reading it on -- a wallet reader sent to /dashboard/billing
// lands on the navy dashboard and is stuck there. Defaults to the wallet,
// which is the surface merchants land on after login.
function computeGuideData(provider, { billingPath = '/account/business/billing' } = {}) {
  const guide = POS_SETUP_GUIDES[provider];
  if (!guide) return null;
  const steps = [...GETTING_STARTED_STEPS, ...guide.steps].map((step) => ({
    ...step,
    text: step.text.replace(/\{\{billingPath\}\}/g, billingPath),
  }));
  return { note: null, ...guide, steps };
}

router.get('/dashboard/pos-setup/guides', requireAuth, (req, res) => {
  res.render('pos-setup-guides-index', { providers: getGuideProviders() });
});

router.get('/dashboard/pos-setup/guide/:provider', requireAuth, (req, res) => {
  const data = computeGuideData(req.params.provider, { billingPath: '/dashboard/billing' });
  if (!data) return res.status(404).send('No setup guide for that POS provider.');
  res.render('pos-setup-guide', data);
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
module.exports.computePosSetupData = computePosSetupData;
module.exports.getGuideProviders = getGuideProviders;
module.exports.computeGuideData = computeGuideData;
