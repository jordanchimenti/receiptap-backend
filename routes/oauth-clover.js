// routes/oauth-clover.js
// Merchant clicks "Connect Clover" -> Clover's login page -> back here.
// Mirrors oauth-square.js's one-time per-merchant handshake, with two real
// differences: Clover's access token expires (~30 min) so every API call
// needs services/cloverService.js's getValidAccessToken, and a Clover
// merchant IS a single location -- there's no separate "pick a location"
// step the way multi-location Square merchants have.

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { CLOVER_AUTH_BASE_URL, exchangeCodeForToken } = require('../services/cloverService');

function requireAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

// Step 1: send the merchant to Clover's own login/authorization page
router.get('/oauth/clover/connect', requireAuth, (req, res) => {
  const redirectUri = `${req.protocol}://${req.get('host')}/oauth/clover/callback`;
  const params = new URLSearchParams({
    client_id: process.env.CLOVER_APP_ID,
    redirect_uri: redirectUri,
    state: req.session.merchantId, // ties the callback back to the right merchant
  });
  res.redirect(`${CLOVER_AUTH_BASE_URL}/oauth/v2/authorize?${params}`);
});

// Step 2: Clover redirects back here with a temporary code AND the merchant
// ID directly (Square only gives you the merchant ID in the token response).
router.get('/oauth/clover/callback', requireAuth, async (req, res) => {
  const { code, merchant_id: cloverMerchantId } = req.query;
  if (!code || !cloverMerchantId) return res.status(400).send('Missing authorization code from Clover');

  let tokens;
  try {
    tokens = await exchangeCodeForToken(code);
  } catch (err) {
    console.error('Clover token exchange failed:', err.message);
    return res.status(400).send('Failed to connect Clover account');
  }

  await prisma.merchant.update({
    where: { id: req.session.merchantId },
    data: {
      cloverMerchantId,
      cloverAccessToken: tokens.access_token,
      cloverRefreshToken: tokens.refresh_token,
      cloverAccessTokenExpiresAt: new Date(tokens.access_token_expiration * 1000),
    },
  });

  res.redirect('/dashboard/pos-setup');
});

// A Clover connection IS one location -- no picker needed, just bind
// whichever puck the merchant selects straight to this Clover merchant ID.
router.post('/dashboard/pos-setup/assign-clover', requireAuth, async (req, res) => {
  const { puckId } = req.body;

  const [puck, merchant] = await Promise.all([
    prisma.puck.findUnique({ where: { id: puckId } }),
    prisma.merchant.findUnique({ where: { id: req.session.merchantId } }),
  ]);
  if (!puck || puck.merchantId !== req.session.merchantId) {
    return res.status(403).json({ error: 'Not your puck' });
  }
  if (!merchant.cloverMerchantId) {
    return res.status(400).json({ error: 'Clover is not connected' });
  }

  await prisma.puck.update({
    where: { id: puckId },
    data: { posLocationId: merchant.cloverMerchantId, posDeviceId: null },
  });
  res.json({ success: true });
});

module.exports = router;
