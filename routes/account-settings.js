// routes/account-settings.js
// Merchant account settings: business info, password, POS disconnect, and
// account deactivation. Distinct from routes/theme-settings.js, which is
// about receipt branding, not the account itself.

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const prisma = require('../lib/prisma');
const { resolveTaxNumberLabel } = require('../lib/taxLabels');
const { stripe } = require('../services/stripeService');
const { uploadProfilePhoto } = require('./billing');
const { DEACTIVATED_MERCHANT_PURGE_DAYS } = require('../config/retention');
const fileStorage = require('../lib/fileStorage');

function requireAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

// Help & support. Replaces what used to be a bare mailto: link in the
// sidebar (partials/dashboard-header.ejs) and on the billing page
// (views/billing.ejs) -- see views/support.ejs for why that stranded people.
router.get('/dashboard/support', requireAuth, async (req, res) => {
  const merchant = await prisma.merchant.findUnique({
    where: { id: req.session.merchantId },
    select: { email: true },
  });
  res.render('support', {
    supportEmail: 'support@receiptap.com',
    merchantEmail: merchant?.email || '',
  });
});

// Shared allowlist for "where should this settings action redirect back
// to" -- same reasoning as lib/safeRedirect.js's safeNextPath, kept local
// to this file since these are POST-body redirect targets, not the
// next-path query param that helper covers. Lets the wallet's dark
// Settings pages (routes/account-business.js) return to themselves instead
// of always landing on the real dashboard's settings page.
const WALLET_SETTINGS_PATHS = ['/account/business/settings', '/account/business/account'];
function settingsRedirectTarget(redirectTo) {
  return WALLET_SETTINGS_PATHS.includes(redirectTo) ? redirectTo : '/dashboard/settings/account';
}

// Wraps the shared multer instance (routes/billing.js) with THIS file's own
// error redirect, since handlePhotoUpload there hardcodes /dashboard/billing.
// `destinationFor` reads req.body.redirectTo the same way every other route
// in this file does, so a bad upload sends the merchant back to whichever
// settings page they were actually on.
function handleProfilePhotoUpload(req, res, next) {
  uploadProfilePhoto(req, res, (err) => {
    if (!err) return next();
    const destination = settingsRedirectTarget(req.body.redirectTo);
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Photo file is too large (2MB max).'
        : 'Please upload a valid image file (PNG, JPG, or WEBP).';
    res.redirect(`${destination}?profileError=${encodeURIComponent(message)}`);
  });
}

router.get('/dashboard/settings/account', requireAuth, async (req, res) => {
  const [merchant, receiptTheme] = await Promise.all([
    prisma.merchant.findUnique({ where: { id: req.session.merchantId } }),
    prisma.receiptTheme.findUnique({ where: { merchantId: req.session.merchantId } }),
  ]);
  res.render('account-settings', {
    merchant,
    receiptTheme,
    businessError: req.query.businessError || null,
    businessSuccess: req.query.businessSuccess === '1',
    passwordError: req.query.passwordError || null,
    passwordSuccess: req.query.passwordSuccess === '1',
    posError: req.query.posError || null,
    purgeDays: DEACTIVATED_MERCHANT_PURGE_DAYS,
  });
});

// POST /dashboard/settings/account/profile — photo, owner name, an optional
// phone number, and (on the pages that still render it) login email.
// Distinct from POST .../business above, which edits businessName -- this
// route never touches it.
//
// email is handled only if the form actually included the field --
// views/business-account.ejs deliberately doesn't (login email lives on
// Business Settings' own card there), and posting without it must not trip
// "Email is required." for a field this form never asked about. Same
// 'field' in req.body reasoning as POST .../business-all below.
router.post('/dashboard/settings/account/profile', requireAuth, handleProfilePhotoUpload, async (req, res) => {
  const { ownerName, email, ownerPhone, redirectTo } = req.body;
  const destination = settingsRedirectTarget(redirectTo);
  const data = { ownerName: ownerName || null, ownerPhone: ownerPhone || null };

  if ('email' in req.body) {
    if (!email) {
      return res.redirect(`${destination}?profileError=` + encodeURIComponent('Email is required.'));
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.redirect(`${destination}?profileError=` + encodeURIComponent('Enter a valid email address.'));
    }
    const existing = await prisma.merchant.findFirst({
      where: { email: normalizedEmail, NOT: { id: req.session.merchantId } },
    });
    if (existing) {
      return res.redirect(`${destination}?profileError=` + encodeURIComponent('That email is already in use by another account.'));
    }
    data.email = normalizedEmail;
  }

  if (req.file) {
    data.profilePhotoUrl = await fileStorage.put('profile-photos', req.file, { prefix: req.session.merchantId });
  }
  await prisma.merchant.update({ where: { id: req.session.merchantId }, data });
  res.redirect(`${destination}?profileSuccess=1`);
});

// POST /dashboard/settings/account/business — update business name/email.
router.post('/dashboard/settings/account/business', requireAuth, async (req, res) => {
  const { businessName, email, phone, redirectTo } = req.body;
  const destination = settingsRedirectTarget(redirectTo);

  if (!businessName || !email) {
    return res.redirect(`${destination}?businessError=` + encodeURIComponent('Business name and email are both required.'));
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await prisma.merchant.findFirst({
    where: { email: normalizedEmail, NOT: { id: req.session.merchantId } },
  });
  if (existing) {
    return res.redirect(`${destination}?businessError=` + encodeURIComponent('That email is already in use by another account.'));
  }

  // phone lives on ReceiptTheme (it's what prints on a receipt) but is edited
  // here, next to the business name -- one field, one place. Absent key means
  // "leave it alone" rather than "clear it", so a form that doesn't render the
  // input can't wipe a saved number; present-but-empty is a real clear, since
  // the field is optional.
  const phoneWrite = 'phone' in req.body ? { phone: phone || null } : {};
  await Promise.all([
    prisma.merchant.update({
      where: { id: req.session.merchantId },
      data: { businessName, email: normalizedEmail },
    }),
    prisma.receiptTheme.upsert({
      where: { merchantId: req.session.merchantId },
      update: phoneWrite,
      create: { merchantId: req.session.merchantId, ...phoneWrite },
    }),
  ]);
  res.redirect(`${destination}?businessSuccess=1`);
});

// POST /dashboard/settings/account/business-all — the wallet's Business
// Settings page, saved in one go.
//
// That page used to be four separate forms with four Save buttons, posting to
// four routes. One sticky Save can only submit one form, so they're merged
// here. The older routes are left in place because the navy dashboard's own
// settings page still posts to them -- this is an additional entry point, not
// a replacement, and the field-ownership rules below are copied from them
// deliberately rather than reinvented:
//
//   Merchant      businessName, email, ownerName, ownerPhone, profilePhotoUrl,
//                 businessEmail, industry, address*
//   ReceiptTheme  phone, gstHstNumber      (both print on a receipt)
//
// `'field' in req.body` rather than a truthiness check throughout: an absent
// key means "this form didn't render that input, leave it alone", while
// present-but-empty is a real clear. Getting that backwards would let this
// page silently wipe a value another page owns.
router.post('/dashboard/settings/account/business-all', requireAuth, handleProfilePhotoUpload, async (req, res) => {
  const b = req.body;
  const destination = settingsRedirectTarget(b.redirectTo);
  const merchantId = req.session.merchantId;
  const fail = (msg) => res.redirect(`${destination}?businessError=` + encodeURIComponent(msg));

  if (!b.businessName || !b.email) {
    return fail('Business name and email are both required.');
  }

  const normalizedEmail = b.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return fail('Enter a valid email address.');
  }
  const clash = await prisma.merchant.findFirst({
    where: { email: normalizedEmail, NOT: { id: merchantId } },
  });
  if (clash) return fail('That email is already in use by another account.');

  if (b.businessEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.businessEmail)) {
    return fail('Enter a valid business email.');
  }

  const merchantData = { businessName: b.businessName, email: normalizedEmail };
  const only = (key, value) => { if (key in b) merchantData[key] = value; };
  only('ownerName', b.ownerName || null);
  only('ownerPhone', b.ownerPhone || null);
  only('businessEmail', b.businessEmail || null);
  only('industry', b.industry || null);
  only('addressLine1', b.addressLine1 || null);
  only('addressLine2', b.addressLine2 || null);
  only('addressCity', b.addressCity || null);
  only('addressRegion', b.addressRegion || null);
  only('addressPostalCode', b.addressPostalCode || null);
  only('addressCountry', b.addressCountry || null);
  if (req.file) merchantData.profilePhotoUrl = await fileStorage.put('profile-photos', req.file, { prefix: merchantId });

  // Both live on ReceiptTheme because both print on a receipt.
  const themeData = {};
  if ('phone' in b) themeData.phone = b.phone || null;
  if ('gstHstNumber' in b) themeData.gstHstNumber = b.gstHstNumber || null;
  // Label and second registration number travel with it -- see the comment on
  // ReceiptTheme.taxNumber2 for why one slot wasn't enough.
  // Both labels arrive from a dropdown now. resolveTaxNumberLabel turns the
  // "Custom…" sentinel into whatever was typed beside it, and leaves a preset
  // alone -- so picking Custom and typing nothing stores a blank rather than
  // printing "__custom__" on every receipt.
  if ('taxNumberLabel' in b) {
    themeData.taxNumberLabel =
      resolveTaxNumberLabel(b.taxNumberLabel, b.taxNumberLabelCustom).slice(0, 20) || null;
  }
  if ('taxNumber2' in b) themeData.taxNumber2 = (b.taxNumber2 || '').trim() || null;
  if ('taxNumber2Label' in b) {
    themeData.taxNumber2Label =
      resolveTaxNumberLabel(b.taxNumber2Label, b.taxNumber2LabelCustom).slice(0, 20) || null;
  }

  await Promise.all([
    prisma.merchant.update({ where: { id: merchantId }, data: merchantData }),
    prisma.receiptTheme.upsert({
      where: { merchantId },
      update: themeData,
      create: { merchantId, ...themeData },
    }),
  ]);

  res.redirect(`${destination}?businessSuccess=1`);
});

// POST /dashboard/settings/account/password — change password, current
// password required to confirm it's really them.
router.post('/dashboard/settings/account/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword, confirmNewPassword, redirectTo } = req.body;
  const destination = settingsRedirectTarget(redirectTo);

  const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
  const currentOk = currentPassword && (await bcrypt.compare(currentPassword, merchant.passwordHash));
  if (!currentOk) {
    return res.redirect(`${destination}?passwordError=` + encodeURIComponent('Current password is incorrect.'));
  }
  if (!newPassword || newPassword.length < 8) {
    return res.redirect(`${destination}?passwordError=` + encodeURIComponent('New password must be at least 8 characters.'));
  }
  if (newPassword !== confirmNewPassword) {
    return res.redirect(`${destination}?passwordError=` + encodeURIComponent('New passwords do not match.'));
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.merchant.update({ where: { id: req.session.merchantId }, data: { passwordHash } });
  res.redirect(`${destination}?passwordSuccess=1`);
});

// POST /dashboard/settings/account/business-profile — the wallet Business
// Settings page's "Business Profile" panel: businessEmail/website/industry
// live on Merchant (account record only, never shown to a customer), while
// gstHstNumber lives on ReceiptTheme (what actually prints on a receipt).
// Receipt Design no longer edits either -- it's design-only now -- so this
// page is the single place both are set. phone is also on ReceiptTheme but
// is edited from the Business information panel, not here.
router.post('/dashboard/settings/account/business-profile', requireAuth, async (req, res) => {
  const { businessEmail, industry, gstHstNumber, redirectTo } = req.body;
  const destination = settingsRedirectTarget(redirectTo);
  const merchantId = req.session.merchantId;

  if (businessEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(businessEmail)) {
    return res.redirect(`${destination}?businessProfileError=` + encodeURIComponent('Enter a valid business email.'));
  }

  await Promise.all([
    prisma.merchant.update({
      where: { id: merchantId },
      data: {
        businessEmail: businessEmail || null,
        // website deliberately absent: it moved to Receipt design's Header
        // block, and writing it here would blank whatever that page saved.
        industry: industry || null,
      },
    }),
    // phone deliberately absent: it moved to the Business information panel
    // above, and writing it here would blank whatever that panel just saved.
    prisma.receiptTheme.upsert({
      where: { merchantId },
      update: { gstHstNumber: gstHstNumber || null },
      create: { merchantId, gstHstNumber: gstHstNumber || null },
    }),
  ]);
  res.redirect(`${destination}?businessProfileSuccess=1`);
});

// POST /dashboard/settings/account/business-address — the one address on
// file, and the one that prints on receipts/PDFs (see businessAddressLines
// in views/receipt.ejs). ReceiptTheme's old free-text `location` field used
// to duplicate this on Receipt Design and is no longer edited or rendered.
router.post('/dashboard/settings/account/business-address', requireAuth, async (req, res) => {
  const { addressLine1, addressLine2, addressCity, addressRegion, addressPostalCode, addressCountry, redirectTo } = req.body;
  const destination = settingsRedirectTarget(redirectTo);

  await prisma.merchant.update({
    where: { id: req.session.merchantId },
    data: {
      addressLine1: addressLine1 || null,
      addressLine2: addressLine2 || null,
      addressCity: addressCity || null,
      addressRegion: addressRegion || null,
      addressPostalCode: addressPostalCode || null,
      addressCountry: addressCountry || null,
    },
  });
  res.redirect(`${destination}?addressSuccess=1`);
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
  const destination =
    redirectTo === '/dashboard/pos-setup' || redirectTo === '/account/business/pos'
      ? redirectTo
      : settingsRedirectTarget(redirectTo);

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
