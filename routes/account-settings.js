// routes/account-settings.js
// Merchant account settings: business info, password, POS disconnect, and
// account deactivation. Distinct from routes/theme-settings.js, which is
// about receipt branding, not the account itself.

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const prisma = require('../lib/prisma');
const { stripe } = require('../services/stripeService');
const { DEACTIVATED_MERCHANT_PURGE_DAYS } = require('../config/retention');

function requireAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

router.get('/dashboard/settings/account', requireAuth, async (req, res) => {
  const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
  res.render('account-settings', {
    merchant,
    businessError: req.query.businessError || null,
    businessSuccess: req.query.businessSuccess === '1',
    passwordError: req.query.passwordError || null,
    passwordSuccess: req.query.passwordSuccess === '1',
    posError: req.query.posError || null,
    purgeDays: DEACTIVATED_MERCHANT_PURGE_DAYS,
  });
});

// POST /dashboard/settings/account/business — update business name/email.
router.post('/dashboard/settings/account/business', requireAuth, async (req, res) => {
  const { businessName, email } = req.body;

  if (!businessName || !email) {
    return res.redirect('/dashboard/settings/account?businessError=' + encodeURIComponent('Business name and email are both required.'));
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await prisma.merchant.findFirst({
    where: { email: normalizedEmail, NOT: { id: req.session.merchantId } },
  });
  if (existing) {
    return res.redirect('/dashboard/settings/account?businessError=' + encodeURIComponent('That email is already in use by another account.'));
  }

  await prisma.merchant.update({
    where: { id: req.session.merchantId },
    data: { businessName, email: normalizedEmail },
  });
  res.redirect('/dashboard/settings/account?businessSuccess=1');
});

// POST /dashboard/settings/account/password — change password, current
// password required to confirm it's really them.
router.post('/dashboard/settings/account/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword, confirmNewPassword } = req.body;

  const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
  const currentOk = currentPassword && (await bcrypt.compare(currentPassword, merchant.passwordHash));
  if (!currentOk) {
    return res.redirect('/dashboard/settings/account?passwordError=' + encodeURIComponent('Current password is incorrect.'));
  }
  if (!newPassword || newPassword.length < 8) {
    return res.redirect('/dashboard/settings/account?passwordError=' + encodeURIComponent('New password must be at least 8 characters.'));
  }
  if (newPassword !== confirmNewPassword) {
    return res.redirect('/dashboard/settings/account?passwordError=' + encodeURIComponent('New passwords do not match.'));
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.merchant.update({ where: { id: req.session.merchantId }, data: { passwordHash } });
  res.redirect('/dashboard/settings/account?passwordSuccess=1');
});

// POST /dashboard/settings/account/disconnect-pos — clears one specific POS
// integration, named by `provider` in the request body. A merchant can have
// several providers connected at once (each is independent -- see
// pos-setup.ejs), so this can no longer guess "whichever one is connected"
// the way the original single-provider version did; the caller says which.
// Existing Puck rows keep their posLocationId/posDeviceId untouched -- they
// just go stale until reconnected, same as before.
const POS_DISCONNECT_FIELDS = {
  square: { squareMerchantId: null, squareAccessToken: null },
  clover: { cloverMerchantId: null, cloverAccessToken: null, cloverRefreshToken: null, cloverAccessTokenExpiresAt: null },
  lightspeed: { lightspeedDomainPrefix: null, lightspeedAccessToken: null, lightspeedRefreshToken: null, lightspeedAccessTokenExpiresAt: null },
  shopify: { shopifyShopDomain: null, shopifyAccessToken: null },
};

router.post('/dashboard/settings/account/disconnect-pos', requireAuth, async (req, res) => {
  const { provider, redirectTo } = req.body;
  const destination = redirectTo === '/dashboard/pos-setup' ? redirectTo : '/dashboard/settings/account';

  const fields = POS_DISCONNECT_FIELDS[provider];
  if (!fields) {
    return res.redirect(`${destination}?posError=${encodeURIComponent('Unknown POS provider.')}`);
  }

  await prisma.merchant.update({ where: { id: req.session.merchantId }, data: fields });
  res.redirect(destination);
});

// POST /dashboard/settings/account/deactivate — cancels billing immediately
// (not at period end, unlike the Billing page's "Cancel Subscription" —
// see docs/LEGAL_REVIEW_NOTES.md item 24) and blocks future logins right
// away. Data itself isn't deleted immediately -- deactivatedAt just starts
// the DEACTIVATED_MERCHANT_PURGE_DAYS grace window (config/retention.js)
// that services/dataRetentionService.js's purgeDeactivatedMerchants() later
// acts on -- but there's no self-serve reactivation flow anywhere in this
// app (routes/auth.js blocks login once isActive is false), so from the
// merchant's own side this is immediate and permanent, not "reversible" in
// any way they can act on themselves. The view (account-settings.ejs) warns
// about this plainly before the confirming click, precisely because the
// consequence is real and can't be undone by the person triggering it.
router.post('/dashboard/settings/account/deactivate', requireAuth, async (req, res) => {
  const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });

  if (stripe && merchant.stripeSubscriptionId) {
    try {
      await stripe.subscriptions.cancel(merchant.stripeSubscriptionId);
    } catch (err) {
      console.error('Failed to cancel Stripe subscription during deactivation:', err.message);
    }
  }

  await prisma.merchant.update({
    where: { id: merchant.id },
    data: { isActive: false, deactivatedAt: new Date(), subscriptionStatus: 'CANCELED' },
  });

  req.session.destroy(() => {
    res.redirect('/login?deactivated=1');
  });
});

module.exports = router;
