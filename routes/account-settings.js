// routes/account-settings.js
// Merchant account settings: business info, password, POS disconnect, and
// account deactivation. Distinct from routes/theme-settings.js, which is
// about receipt branding, not the account itself.

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const prisma = require('../lib/prisma');
const { stripe } = require('../services/stripeService');

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

// POST /dashboard/settings/account/disconnect-pos — clears whichever POS
// integration is connected. Existing Puck rows keep their posLocationId/
// posDeviceId untouched — they just go stale until reconnected.
router.post('/dashboard/settings/account/disconnect-pos', requireAuth, async (req, res) => {
  const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });

  if (merchant.squareMerchantId) {
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { squareMerchantId: null, squareAccessToken: null },
    });
  } else if (merchant.shopifyShopDomain) {
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { shopifyShopDomain: null, shopifyAccessToken: null },
    });
  }
  res.redirect('/dashboard/settings/account');
});

// POST /dashboard/settings/account/deactivate — cancels billing, blocks
// future logins. Data isn't touched immediately (a mistaken deactivation
// should be reversible without having already lost anything), but sets
// deactivatedAt so services/dataRetentionService.js's purgeDeactivatedMerchants()
// knows when the DEACTIVATED_MERCHANT_PURGE_DAYS grace window (config/retention.js)
// started -- after which this merchant's data is actually purged for real.
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
