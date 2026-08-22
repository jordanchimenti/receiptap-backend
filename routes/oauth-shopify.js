// routes/oauth-shopify.js
// Unlike Square/Clover/Lightspeed, a Shopify connection can't start with a
// single "Connect" link straight to Shopify's login page -- there's no
// shared authorize host, the merchant's OWN *.myshopify.com domain has to
// be known first. So /oauth/shopify/connect takes a `shop` param (collected
// from a small form in pos-setup.ejs) and only THEN redirects onward.
// Like Square (and unlike Clover/Lightspeed), the resulting access token is
// offline and never expires -- no refresh logic needed here.

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const {
  isValidShopDomain,
  buildAuthorizeUrl,
  verifyOAuthCallback,
  exchangeCodeForToken,
  createWebhookSubscription,
} = require('../services/shopifyService');
const { posReturnPath } = require('../lib/posReturnPath');

function requireAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

// Step 1: merchant submits their shop domain, gets sent to Shopify's own
// login/authorization page on that shop.
router.get('/oauth/shopify/connect', requireAuth, (req, res) => {
  const shop = (req.query.shop || '').trim().toLowerCase();
  if (!isValidShopDomain(shop)) {
    return res.status(400).send('Enter your shop domain as yourstorename.myshopify.com');
  }

  const redirectUri = `${req.protocol}://${req.get('host')}/oauth/shopify/callback`;
  // Round-tripped back on the callback below to know where to send the
  // merchant afterward -- see the identical comment in oauth-square.js.
  // Shopify's own HMAC signature (verifyOAuthCallback below) covers this
  // value too, same as every other query param it echoes back, so
  // repurposing it doesn't weaken that check.
  res.redirect(buildAuthorizeUrl(shop, redirectUri, posReturnPath(req.query.next)));
});

// Step 2: Shopify redirects back here with a temporary code AND the shop
// domain directly -- the shop IS the identity, same role as Lightspeed's
// domain prefix.
router.get('/oauth/shopify/callback', requireAuth, async (req, res) => {
  const { code, shop, state } = req.query;
  if (!code || !isValidShopDomain(shop)) return res.status(400).send('Missing or invalid shop from Shopify');
  if (!verifyOAuthCallback(req.query)) return res.status(400).send('Could not verify this request came from Shopify');

  let tokens;
  try {
    tokens = await exchangeCodeForToken(shop, code);
  } catch (err) {
    console.error('Shopify token exchange failed:', err.message);
    return res.status(400).send('Failed to connect Shopify account');
  }

  await prisma.merchant.update({
    where: { id: req.session.merchantId },
    data: {
      shopifyShopDomain: shop,
      shopifyAccessToken: tokens.access_token,
    },
  });

  // Unlike Square (one app-level Notification URL covers every merchant),
  // each connected shop needs its own webhook subscription created via API
  // -- do it now, right after connecting. Best-effort: a failure here
  // shouldn't block the connection itself, but does mean receipts won't
  // generate until this succeeds.
  try {
    const webhookUrl = `${req.protocol}://${req.get('host')}/webhooks/pos/shopify`;
    await createWebhookSubscription(shop, tokens.access_token, webhookUrl);
  } catch (err) {
    console.error('Shopify webhook subscription failed:', err.message);
  }

  res.redirect(posReturnPath(state));
});

// A Shopify connection is treated as one location for now -- same
// simplification as Clover/Lightspeed's single-retailer assignment, not a
// Shopify API limitation (a shop CAN have multiple physical locations; this
// just doesn't offer a picker for them yet).
router.post('/dashboard/pos-setup/assign-shopify', requireAuth, async (req, res) => {
  const { puckId } = req.body;

  const [puck, merchant] = await Promise.all([
    prisma.puck.findUnique({ where: { id: puckId } }),
    prisma.merchant.findUnique({ where: { id: req.session.merchantId } }),
  ]);
  if (!puck || puck.merchantId !== req.session.merchantId) {
    return res.status(403).json({ error: 'Not your puck' });
  }
  if (!merchant.shopifyShopDomain) {
    return res.status(400).json({ error: 'Shopify is not connected' });
  }

  await prisma.puck.update({
    where: { id: puckId },
    data: { posLocationId: merchant.shopifyShopDomain, posDeviceId: null },
  });
  res.json({ success: true });
});

module.exports = router;
