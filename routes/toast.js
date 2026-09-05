// routes/toast.js
// Toast POS connection. Unlike oauth-square.js/oauth-clover.js/
// oauth-lightspeed.js/oauth-shopify.js, there is no redirect-based OAuth
// handshake here -- Toast's self-serve "Standard API access" has the
// MERCHANT generate a static clientId/clientSecret themselves in their own
// Toast Web account and hand them to this app directly. This route is the
// form that takes those three values, validates them by actually
// authenticating with Toast before saving anything, and stores them.
const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { login } = require('../services/toastService');
const { posReturnPath } = require('../lib/posReturnPath');

function requireAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

// Saves a restaurant's clientId/clientSecret/restaurantGuid -- only after
// confirming they actually work, so a typo doesn't silently save a dead
// connection that then fails on every poll. redirectTo mirrors every other
// POS action's own field (see views/partials/disconnect-pos-form.ejs and
// the OAuth routes' `state` round-trip): validated against the same
// allowlist so this can be posted from either dashboard surface.
router.post('/dashboard/pos-setup/connect-toast', requireAuth, async (req, res) => {
  const { clientId, clientSecret, restaurantGuid, redirectTo } = req.body;
  const returnPath = posReturnPath(redirectTo);

  if (!clientId || !clientSecret || !restaurantGuid) {
    return res.redirect(`${returnPath}?posError=${encodeURIComponent('Please fill in all three fields.')}`);
  }

  let token;
  try {
    token = await login(clientId.trim(), clientSecret.trim());
  } catch (err) {
    console.error('Toast credential validation failed:', err.message);
    return res.redirect(`${returnPath}?posError=${encodeURIComponent("Couldn't connect — check your Client ID and Client Secret and try again.")}`);
  }

  const trimmedGuid = restaurantGuid.trim();
  const existing = await prisma.merchant.findUnique({ where: { toastRestaurantGuid: trimmedGuid } });
  if (existing && existing.id !== req.session.merchantId) {
    return res.redirect(`${returnPath}?posError=${encodeURIComponent('That Restaurant GUID is already connected to a different ReceipTap account.')}`);
  }

  await prisma.merchant.update({
    where: { id: req.session.merchantId },
    data: {
      toastRestaurantGuid: trimmedGuid,
      toastClientId: clientId.trim(),
      toastClientSecret: clientSecret.trim(),
      toastAccessToken: token.accessToken,
      toastAccessTokenExpiresAt: new Date(Date.now() + token.expiresIn * 1000),
      // Starts polling from now, not from whenever this restaurant's Toast
      // history began -- same reasoning as a fresh OAuth connection on any
      // other provider, which only ever sees sales from the moment it
      // connects onward.
      toastLastPollAt: new Date(),
    },
  });

  res.redirect(returnPath);
});

// A Toast connection is one restaurant -- no picker needed, just bind
// whichever puck the merchant selects straight to this restaurant's GUID,
// same pattern as oauth-lightspeed.js's assign-lightspeed.
router.post('/dashboard/pos-setup/assign-toast', requireAuth, async (req, res) => {
  const { puckId } = req.body;

  const [puck, merchant] = await Promise.all([
    prisma.puck.findUnique({ where: { id: puckId } }),
    prisma.merchant.findUnique({ where: { id: req.session.merchantId } }),
  ]);
  if (!puck || puck.merchantId !== req.session.merchantId) {
    return res.status(403).json({ error: 'Not your puck' });
  }
  if (!merchant.toastRestaurantGuid) {
    return res.status(400).json({ error: 'Toast is not connected' });
  }

  await prisma.puck.update({
    where: { id: puckId },
    data: { posLocationId: merchant.toastRestaurantGuid, posDeviceId: null },
  });
  res.json({ success: true });
});

module.exports = router;
