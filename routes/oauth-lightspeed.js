// routes/oauth-lightspeed.js
// Merchant clicks "Connect Lightspeed" -> Lightspeed's login page -> back
// here. Mirrors oauth-square.js/oauth-clover.js's one-time per-merchant
// handshake. Like Clover (and unlike Square), the access token expires and
// needs services/lightspeedService.js's getValidAccessToken. Like Clover, a
// Lightspeed (X-Series) connection IS one retailer -- no separate "pick a
// location" step, just assign a puck straight to it.

const express = require('express');
const { getBaseUrl } = require('../lib/baseUrl');
const router = express.Router();
const prisma = require('../lib/prisma');
const { LIGHTSPEED_AUTH_BASE_URL, LIGHTSPEED_SCOPES, exchangeCodeForToken, createWebhookSubscription } = require('../services/lightspeedService');
const { posReturnPath } = require('../lib/posReturnPath');

function requireAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

// Step 1: send the merchant to Lightspeed's own login/authorization page
router.get('/oauth/lightspeed/connect', requireAuth, (req, res) => {
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
  const redirectUri = `${getBaseUrl(req)}/oauth/lightspeed/callback`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.LIGHTSPEED_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: LIGHTSPEED_SCOPES,
    // Round-tripped back on the callback below to know where to send the
    // merchant afterward -- see the identical comment in oauth-square.js.
    state: posReturnPath(req.query.next),
  });
  res.redirect(`${LIGHTSPEED_AUTH_BASE_URL}/connect?${params}`);
});

// Step 2: Lightspeed redirects back here with a temporary code AND the
// retailer's domain prefix directly (X-Series has no separate numeric
// merchant ID the way Square/Clover do -- the domain prefix IS the identity,
// and every subsequent API call is made against that retailer's own
// subdomain).
router.get('/oauth/lightspeed/callback', requireAuth, async (req, res) => {
  const { code, domain_prefix: domainPrefix, state } = req.query;
  if (!code || !domainPrefix) return res.status(400).send('Missing authorization code from Lightspeed');

  const redirectUri = `${getBaseUrl(req)}/oauth/lightspeed/callback`;

  let tokens;
  try {
    tokens = await exchangeCodeForToken(domainPrefix, code, redirectUri);
  } catch (err) {
    console.error('Lightspeed token exchange failed:', err.message);
    return res.status(400).send('Failed to connect Lightspeed account');
  }

  await prisma.merchant.update({
    where: { id: req.session.merchantId },
    data: {
      lightspeedDomainPrefix: domainPrefix,
      lightspeedAccessToken: tokens.access_token,
      lightspeedRefreshToken: tokens.refresh_token,
      lightspeedAccessTokenExpiresAt: new Date(tokens.expires * 1000),
    },
  });

  // Unlike Square (one app-level webhook signing key covers every
  // merchant), X-Series needs each retailer's own webhook subscription
  // created via API -- do it now, right after connecting, rather than
  // leaving the merchant connected but silently never receiving sale
  // events. Best-effort: a failure here shouldn't block the connection
  // itself (the merchant is already connected and can retry), but it does
  // mean receipts won't generate until this succeeds.
  try {
    // Pinned via getBaseUrl, same as redirectUri above -- this is a URL
    // Lightspeed's own servers call indefinitely from the outside, not a
    // link the merchant opens themselves, so it has to be the real public
    // domain regardless of what host this request happened to arrive on.
    const webhookUrl = `${getBaseUrl(req)}/webhooks/pos/lightspeed`;
    await createWebhookSubscription(domainPrefix, tokens.access_token, webhookUrl);
  } catch (err) {
    console.error('Lightspeed webhook subscription failed:', err.message);
  }

  res.redirect(posReturnPath(state));
});

// A Lightspeed (X-Series) connection IS one retailer -- no picker needed,
// just bind whichever puck the merchant selects straight to this retailer's
// domain prefix, same pattern as oauth-clover.js's assign-clover.
router.post('/dashboard/pos-setup/assign-lightspeed', requireAuth, async (req, res) => {
  const { puckId } = req.body;

  const [puck, merchant] = await Promise.all([
    prisma.puck.findUnique({ where: { id: puckId } }),
    prisma.merchant.findUnique({ where: { id: req.session.merchantId } }),
  ]);
  if (!puck || puck.merchantId !== req.session.merchantId) {
    return res.status(403).json({ error: 'Not your puck' });
  }
  if (!merchant.lightspeedDomainPrefix) {
    return res.status(400).json({ error: 'Lightspeed is not connected' });
  }

  await prisma.puck.update({
    where: { id: puckId },
    data: { posLocationId: merchant.lightspeedDomainPrefix, posDeviceId: null },
  });
  res.json({ success: true });
});

module.exports = router;
