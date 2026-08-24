// routes/customer-account.js
// The "Phase 2" cross-merchant wallet — a customer's receipts from EVERY
// ReceipTap merchant they've shopped at, in one place.
// This is a separate identity/session from merchant accounts — a person
// could be both a shopper (Customer) and, elsewhere, a business (Merchant).

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { categorizeInBackground, categorizeScannedInBackground, CATEGORIES } = require('../services/categorize-receipt');
const { extractReceiptData } = require('../services/scanReceiptService');
const { sendPasswordResetEmail } = require('../services/emailService');
const fileStorage = require('../lib/fileStorage');
// A wallet customer joining the Partner Program signs up as a standalone
// affiliate, not a merchant one -- REGULAR_AFFILIATE_RATE is their rate.
const { REGULAR_AFFILIATE_RATE } = require('../services/affiliateRates');
const { deleteShopperEverywhere } = require('../services/dataRetentionService');
const prisma = require('../lib/prisma');
const {
  isDeductible,
  deductibleSource,
  overridesCategoryRule,
  deductibleWhereClause,
} = require('../lib/receiptDeductible');
const {
  effectiveWarrantyMonths,
  computeWarrantyExpiry,
  warrantySource,
} = require('../lib/receiptWarranty');
const { csvCell } = require('../lib/csvCell');
const { receiptDateLabels } = require('../lib/receiptDateLabels');
const { parseMoneyToCents, parseDateOrNull } = require('../lib/parseReceiptFields');
const { findDuplicateReceipt } = require('../lib/findDuplicateReceipt');
const { listNotifications, markAllRead, notifyReceiptSaved, notifyReceiptDeleted } = require('../services/notificationService');
const pushService = require('../services/pushService');
const { REFERRAL_WINDOW_DAYS } = require('../lib/referralAttribution');
const { listIdentifiersForShopper, revokeIdentifierByHash } = require('../services/shopperIdentity');
const { claimReceiptForShopper } = require('../services/claimReceipt');
const { getBaseUrl } = require('../lib/baseUrl');
const { buildState, parseState } = require('../lib/oauthState');
const appleAuthService = require('../services/appleAuthService');
const microsoftAuthService = require('../services/microsoftAuthService');
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// Scanned-receipt photo uploads -- same local-disk pattern as
// routes/billing.js's profile-photo upload.
//
// Held in memory rather than written to disk, then handed to lib/fileStorage,
// which puts it in Supabase Storage when configured and falls back to local
// disk otherwise. The photo is the record a tax authority actually accepts, so
// it must not live somewhere a redeploy erases.
const ALLOWED_SCAN_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const uploadReceiptScan = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB -- receipts need more detail than a profile photo to stay legible
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_SCAN_TYPES.includes(file.mimetype)) {
      return cb(new Error('INVALID_SCAN_TYPE'));
    }
    cb(null, true);
  },
}).single('receiptPhoto');

function handleReceiptScanUpload(req, res, next) {
  uploadReceiptScan(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Photo file is too large (5MB max).'
        : 'Please upload a valid image file (PNG, JPG, or WEBP).';
    res.redirect(`/account/receipts/scan?error=${encodeURIComponent(message)}`);
  });
}


function requireCustomerAuth(req, res, next) {
  if (!req.session?.customerId) {
    return res.redirect(`/account/login?redirect=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

// Help & support. Replaces what used to be a bare mailto: link in the More
// menu -- see views/account-support.ejs for why that stranded people.
router.get('/account/support', requireCustomerAuth, async (req, res) => {
  const customer = await prisma.customer.findUnique({ where: { id: req.session.customerId } });
  res.render('account-support', {
    supportEmail: 'support@receiptap.com',
    customerEmail: customer?.email || '',
  });
});

// --- Alerts tab -------------------------------------------------------------
// Everything we've told this customer. Opening the tab clears the badge:
// `wasUnread` is captured before markAllRead so this one render can still
// show them which rows were new.
router.get('/account/notifications', requireCustomerAuth, async (req, res) => {
  const rows = await listNotifications(req.session.customerId);
  const notifications = rows.map((note) => ({
    type: note.type,
    title: note.title,
    body: note.body,
    linkUrl: note.linkUrl,
    wasUnread: note.readAt === null,
    whenText: relativeTime(note.createdAt),
  }));

  const pushSubscriptions = pushService.isPushConfigured()
    ? await pushService.countSubscriptions(req.session.customerId)
    : 0;

  await markAllRead(req.session.customerId);
  res.locals.unreadCount = 0; // the bar renders after this, so don't show a badge we just cleared

  res.render('account-notifications', {
    notifications,
    pushConfigured: pushService.isPushConfigured(),
    pushPublicKey: pushService.publicKey(),
    pushSubscriptions,
  });
});

// --- Web push subscription --------------------------------------------------
// The browser does the hard part (permission prompt, key generation); these
// two just store and forget what it hands back.
router.post('/account/push/subscribe', requireCustomerAuth, async (req, res) => {
  if (!pushService.isPushConfigured()) return res.status(503).json({ error: 'Push is not configured' });

  const saved = await pushService.saveSubscription(req.session.customerId, req.body.subscription);
  if (!saved) return res.status(400).json({ error: 'Incomplete subscription' });

  res.json({ success: true });
});

router.post('/account/push/unsubscribe', requireCustomerAuth, async (req, res) => {
  await pushService.removeSubscription(req.body.endpoint);
  res.json({ success: true });
});

// "2 hours ago" reads better than a timestamp on something that just happened,
// and everything on this page is recent by nature.
function relativeTime(date) {
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;

  return date.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
}

// --- Add to home screen ------------------------------------------------------
// One page for both account types -- it's the same app either way. Reachable
// with either session, since a merchant reaching it from the business
// checklist may well not have a shopper account at all.
router.get('/account/install', async (req, res) => {
  const isCustomer = Boolean(req.session?.customerId);
  if (!isCustomer && !req.session?.merchantId) {
    return res.redirect(`/account/login?redirect=${encodeURIComponent('/account/install')}`);
  }

  res.render('account-install', {
    isCustomer,
    backUrl: isCustomer ? '/account/receipts' : '/account/business',
    pushConfigured: pushService.isPushConfigured(),
    pushPublicKey: pushService.publicKey(),
    pushSubscriptions: isCustomer ? await pushService.countSubscriptions(req.session.customerId) : 0,
  });
});

// Polled by the install page while it sits open in Safari. There is no way for
// a Safari tab to notice that the user just added the site to their home
// screen -- navigator.standalone stays false there forever. But the INSTALLED
// copy pings /account/install/installed the first time it opens, so the tab
// can watch the server for that and react. Cross-context detection, without
// pretending Safari told us anything.
router.get('/account/install/status', async (req, res) => {
  const [customer, merchant] = await Promise.all([
    req.session?.customerId
      ? prisma.customer.findUnique({ where: { id: req.session.customerId }, select: { homeScreenAddedAt: true } })
      : null,
    req.session?.merchantId
      ? prisma.merchant.findUnique({ where: { id: req.session.merchantId }, select: { homeScreenAddedAt: true } })
      : null,
  ]);

  res.json({ installed: Boolean(customer?.homeScreenAddedAt || merchant?.homeScreenAddedAt) });
});

// Marks the setup step done. Called by the shared head script whenever a page
// loads in standalone display mode, and straight after an accepted install
// prompt -- so it's an observed fact, not a "they clicked the button" flag.
// Stamps whichever sessions are present: one browser can hold both.
router.post('/account/install/installed', async (req, res) => {
  const now = new Date();
  const writes = [];

  if (req.session?.customerId) {
    // updateMany with a null guard so the FIRST time is the time recorded,
    // and so this can be called on every cold start without a write.
    writes.push(
      prisma.customer.updateMany({
        where: { id: req.session.customerId, homeScreenAddedAt: null },
        data: { homeScreenAddedAt: now },
      }),
    );
  }
  if (req.session?.merchantId) {
    writes.push(
      prisma.merchant.updateMany({
        where: { id: req.session.merchantId, homeScreenAddedAt: null },
        data: { homeScreenAddedAt: now },
      }),
    );
  }

  await Promise.all(writes);
  res.json({ success: true });
});

// --- Login / signup pages ---------------------------------------------------

router.get('/account/login', (req, res) => {
  res.render('account-login', {
    error: null,
    deleted: req.query.deleted === '1',
    redirect: req.query.redirect || '/account/receipts',
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    appleClientId: process.env.APPLE_CLIENT_ID || '',
    microsoftClientId: process.env.MICROSOFT_CLIENT_ID || '',
  });
});

// Thank-you page shown once, straight after a shopper creates a wallet account
// from a receipt (routes/email-capture.js redirects here). Names the merchant
// who introduced them, both as a courtesy and because that merchant is the one
// credited if this person later signs their own business up.
router.get('/account/welcome', async (req, res) => {
  if (!req.session?.customerId) return res.redirect('/account/login');

  const customer = await prisma.customer.findUnique({ where: { id: req.session.customerId } });
  if (!customer) return res.redirect('/account/login');

  // Their most recent receipt tells us which shop this was -- no extra state
  // to thread through the capture request.
  const latest = await prisma.transaction.findFirst({
    where: { customerId: customer.id },
    orderBy: { createdAt: 'desc' },
    include: { merchant: { select: { businessName: true } } },
  });

  res.render('account-welcome', {
    customerEmail: customer.email,
    customerName: customer.name || null,
    merchantName: latest?.merchant?.businessName || null,
    transactionId: latest?.id || null,
    referralWindowDays: REFERRAL_WINDOW_DAYS,
  });
});

router.get('/account/signup', (req, res) => {
  res.render('account-signup', {
    error: null,
    redirect: req.query.redirect || '/account/receipts',
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    appleClientId: process.env.APPLE_CLIENT_ID || '',
    microsoftClientId: process.env.MICROSOFT_CLIENT_ID || '',
  });
});

// --- Signup / login (email + password) --------------------------------------

router.post('/account/signup', async (req, res) => {
  const { email, password, confirmPassword } = req.body;
  // Client-side match check (views/account-signup.ejs) is UX only -- this
  // is the real gate, same reasoning as the merchant signup form's
  // equivalent check in routes/auth.js.
  if (password !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match.' });

  const existing = await prisma.customer.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) return res.status(400).json({ error: 'Account already exists, log in instead' });

  const passwordHash = await bcrypt.hash(password, 10);
  const customer = await prisma.customer.create({ data: { email: email.toLowerCase(), passwordHash } });

  req.session.customerId = customer.id;
  res.json({ success: true });
});

router.post('/account/login', async (req, res) => {
  const { email, password } = req.body;
  const customer = await prisma.customer.findUnique({ where: { email: email.toLowerCase() } });
  if (!customer || !customer.passwordHash || !(await bcrypt.compare(password, customer.passwordHash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  req.session.customerId = customer.id;
  res.json({ success: true });
});

// --- Sign in with Google (doubles as signup — one step for both) ------------
// Used by both the login page and the signup page: if the Google account's
// email doesn't have a Customer record yet, one is created automatically.
// Same verify-then-upsert pattern as the receipt-save modal's Google option.
router.post('/account/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Missing Google credential' });

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    return res.status(401).json({ error: 'Could not verify Google sign-in' });
  }

  if (!payload.email) return res.status(400).json({ error: 'Google account has no email' });

  const customer = await prisma.customer.upsert({
    where: { email: payload.email.toLowerCase() },
    update: { googleId: payload.sub, name: payload.name || undefined },
    create: { email: payload.email.toLowerCase(), googleId: payload.sub, name: payload.name || null },
  });

  req.session.customerId = customer.id;
  res.json({ success: true });
});

// --- Sign in with Apple / Microsoft (also doubles as signup) ----------------
// Redirect-based, not a JS credential POST like Google above -- neither
// provider has a drop-in JS widget used elsewhere in this app. One
// connect/callback pair each, shared by both the login and signup pages,
// same as the Google endpoint above. No consent gate here, matching the
// rest of customer signup (unlike the merchant side, which requires one).
function renderCustomerOAuthError(res, error) {
  if (!error.status) console.error('OAuth customer sign-in failed:', error);
  res.status(error.status || 500).render('account-login', {
    error: error.status ? error.message : 'Something went wrong on our end — please try again in a moment.',
    redirect: '/account/receipts',
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    appleClientId: process.env.APPLE_CLIENT_ID || '',
    microsoftClientId: process.env.MICROSOFT_CLIENT_ID || '',
  });
}

router.get('/account/apple/connect', (req, res) => {
  const { nonce, state } = buildState({ redirect: req.query.redirect || '/account/receipts' });
  req.session.appleOauthNonce = nonce;
  const redirectUri = `${getBaseUrl(req)}/account/apple/callback`;
  res.redirect(appleAuthService.buildAuthorizeUrl(redirectUri, state));
});

router.post('/account/apple/callback', async (req, res) => {
  const parsedState = parseState(req.body.state);
  const nonceOk = parsedState && parsedState.nonce === req.session.appleOauthNonce;
  delete req.session.appleOauthNonce;

  if (!req.body.code || !nonceOk) {
    return renderCustomerOAuthError(res, Object.assign(new Error('Could not verify Apple sign-in.'), { status: 400 }));
  }

  try {
    const redirectUri = `${getBaseUrl(req)}/account/apple/callback`;
    const tokens = await appleAuthService.exchangeCodeForToken(req.body.code, redirectUri);
    const identity = await appleAuthService.verifyIdToken(tokens.id_token);
    if (!identity.email) throw Object.assign(new Error('Apple account has no email'), { status: 400 });

    let name = null;
    try {
      name = req.body.user ? JSON.parse(req.body.user).name?.firstName : null;
    } catch {
      // malformed/missing -- fine, name just stays unset
    }

    const email = identity.email.toLowerCase();
    const customer = await prisma.customer.upsert({
      where: { email },
      update: { appleId: identity.sub, name: name || undefined },
      create: { email, appleId: identity.sub, name },
    });

    req.session.customerId = customer.id;
    res.redirect(parsedState.redirect || '/account/receipts');
  } catch (err) {
    renderCustomerOAuthError(res, err);
  }
});

router.get('/account/microsoft/connect', (req, res) => {
  const { nonce, state } = buildState({ redirect: req.query.redirect || '/account/receipts' });
  req.session.microsoftOauthNonce = nonce;
  const redirectUri = `${getBaseUrl(req)}/account/microsoft/callback`;
  res.redirect(microsoftAuthService.buildAuthorizeUrl(redirectUri, state));
});

router.get('/account/microsoft/callback', async (req, res) => {
  const parsedState = parseState(req.query.state);
  const nonceOk = parsedState && parsedState.nonce === req.session.microsoftOauthNonce;
  delete req.session.microsoftOauthNonce;

  if (!req.query.code || !nonceOk) {
    return renderCustomerOAuthError(res, Object.assign(new Error('Could not verify Microsoft sign-in.'), { status: 400 }));
  }

  try {
    const redirectUri = `${getBaseUrl(req)}/account/microsoft/callback`;
    const tokens = await microsoftAuthService.exchangeCodeForToken(req.query.code, redirectUri);
    const identity = await microsoftAuthService.verifyIdToken(tokens.id_token);
    if (!identity.email) throw Object.assign(new Error('Microsoft account has no email'), { status: 400 });

    const email = identity.email.toLowerCase();
    const customer = await prisma.customer.upsert({
      where: { email },
      update: { microsoftId: identity.sub },
      create: { email, microsoftId: identity.sub },
    });

    req.session.customerId = customer.id;
    res.redirect(parsedState.redirect || '/account/receipts');
  } catch (err) {
    renderCustomerOAuthError(res, err);
  }
});

// --- "Forgot password?" flow -------------------------------------------------

router.get('/account/forgot-password', (req, res) => res.render('account-forgot-password', { error: null, sent: false }));

router.post('/account/forgot-password', async (req, res) => {
  const { email } = req.body;

  try {
    const customer = email ? await prisma.customer.findUnique({ where: { email: email.toLowerCase() } }) : null;

    // Always render the same success state whether or not the email has an
    // account -- otherwise this becomes a way to check who's a customer.
    if (customer) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      await prisma.customer.update({
        where: { id: customer.id },
        data: { resetToken, resetTokenExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
      });

      const resetUrl = `${req.protocol}://${req.get('host')}/account/reset-password/${resetToken}`;
      await sendPasswordResetEmail({ email: customer.email, name: customer.name }, resetUrl);
    }

    res.render('account-forgot-password', { error: null, sent: true });
  } catch (err) {
    console.error('Forgot-password request failed:', err);
    res.render('account-forgot-password', { error: 'Something went wrong on our end — please try again in a moment.', sent: false });
  }
});

router.get('/account/reset-password/:token', async (req, res) => {
  const customer = await prisma.customer.findUnique({ where: { resetToken: req.params.token } });
  const valid = Boolean(customer && customer.resetTokenExpiresAt > new Date());
  res.render('account-reset-password', { token: req.params.token, valid, error: null });
});

router.post('/account/reset-password/:token', async (req, res) => {
  const { password, confirmPassword } = req.body;
  const customer = await prisma.customer.findUnique({ where: { resetToken: req.params.token } });
  const valid = Boolean(customer && customer.resetTokenExpiresAt > new Date());

  if (!valid) {
    return res.render('account-reset-password', { token: req.params.token, valid: false, error: null });
  }
  if (!password || password.length < 8) {
    return res.render('account-reset-password', { token: req.params.token, valid: true, error: 'Password must be at least 8 characters.' });
  }
  if (password !== confirmPassword) {
    return res.render('account-reset-password', { token: req.params.token, valid: true, error: 'Passwords do not match.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.customer.update({
    where: { id: customer.id },
    data: { passwordHash, resetToken: null, resetTokenExpiresAt: null },
  });

  req.session.customerId = customer.id;
  res.redirect('/account/receipts');
});

// --- Claiming a receipt into the wallet ------------------------------------

// Called silently by the receipt page's Save to Photos/PDF buttons when the
// browser already has a recognized customer session (from signing up on an
// earlier receipt) -- links THIS transaction to that same wallet too, with no
// separate "save to account" button needed. requireCustomerAuth is a no-op
// guard here since the caller only invokes this after confirming a session
// exists; a first-time visitor goes through the email-capture flow instead,
// which creates the session and links the transaction in one step.
// Kept for the Save/Print/Join buttons, which still call it -- and for anyone
// whose session began after the page loaded. Routed through the shared claim
// so it can't drift from the on-view path, and so it inherits the guard that
// used to be missing here: this endpoint previously reassigned the receipt
// unconditionally, meaning a signed-in shopper opening someone else's receipt
// URL took it from them.
router.post('/receipt/:transactionId/save', requireCustomerAuth, async (req, res) => {
  const outcome = await claimReceiptForShopper(req.params.transactionId, req.session.customerId);
  if (outcome === 'not-found') return res.status(404).json({ error: 'Receipt not found' });
  if (outcome === 'owned-by-other') {
    return res.status(409).json({ error: 'This receipt is already saved to another wallet.' });
  }
  res.json({ success: true, outcome });
});

// --- The wallet itself ------------------------------------------------------

// "Visa •••• 6123" for a tapped receipt, built fresh from cardBrand/cardLast4
// rather than reusing Transaction.paymentMethod -- that column means
// different things per POS provider (Square formats it exactly like this,
// but Shopify stores the payment GATEWAY name there instead, e.g.
// "shopify_payments", not a card brand). cardBrand/cardLast4 are the two
// fields every provider that captures this populates consistently.
//
// Falls back to paymentMethod when it's already a card-shaped string ("••••"
// present) -- real Square transactions from before this app captured
// cardBrand/cardLast4 separately only have this older combined field, and
// those receipts shouldn't lose their payment info just because a later
// migration added columns nothing backfilled. Shown as-is when it's this
// fallback (Square's own casing/spacing), not reformatted to match the
// fresh case below -- a legacy row looking slightly different is an
// acceptable rough edge, not worth re-parsing a free-text string over.
//
// Null on a cash sale or a provider that doesn't report card details at all
// (Lightspeed's X-Series payload didn't, per CLAUDE.md) -- no badge, not a
// guess.
function cardLabel(cardBrand, cardLast4, paymentMethod) {
  if (cardBrand && cardLast4) return `${formatCardBrand(cardBrand)} •••• ${cardLast4}`;
  if (paymentMethod && paymentMethod.includes('••••')) return paymentMethod;
  return null;
}

// Square reports brand in shouting-caps with underscores ("AMERICAN_EXPRESS");
// title-case only when the whole string is uppercase, so a brand that
// arrives already nicely cased (Shopify sends "Visa") is left alone.
function formatCardBrand(brand) {
  const spaced = brand.replace(/_/g, ' ');
  if (spaced !== spaced.toUpperCase()) return spaced;
  return spaced.replace(/\S+/g, (word) => word[0] + word.slice(1).toLowerCase());
}

// "Warranty until Mar 2027" on a row, or null if there's nothing to show --
// no estimate, or one that's already passed (an expired badge on every old
// receipt would be noise, not a service). UTC, to match how
// warrantyExpiresAt itself is computed (lib/receiptWarranty.js) off a
// purchase date that may itself be UTC-midnight-only with no time-of-day
// meaning (a ScannedReceipt.purchaseDate) -- local-time formatting could
// print the wrong month for a date within a few hours of UTC midnight.
function warrantyExpiresLabel(warrantyExpiresAt) {
  if (!warrantyExpiresAt || warrantyExpiresAt <= new Date()) return null;
  return warrantyExpiresAt.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// Text for the tappable warranty control below the row -- null means don't
// show the control at all. Shown whenever there's an actual estimate or
// answer to correct (months !== null); not shown just because a receipt was
// categorized, or every coffee run would carry a permanent "Add warranty"
// tap target nobody asked for. Correcting a wrong estimate is v1; adding one
// from scratch where the AI found nothing is a later, separate feature.
function warrantyBadgeText(warrantyExpiresAt, months) {
  if (months === null) return null;
  const label = warrantyExpiresLabel(warrantyExpiresAt);
  if (label) return `Warranty until ${label}`;
  if (warrantyExpiresAt) return 'Warranty expired'; // was set, now in the past
  return 'No warranty'; // months === 0, the customer said so explicitly
}

// Shared by the wallet page and its CSV export, so the two can never drift
// out of sync on what "the current filters" actually match.
function buildWalletWhere(customerId, { search, from, to, category, deductible, deductibleCategories = [] }) {
  return {
    customerId,
    ...(search ? { merchant: { businessName: { contains: search, mode: 'insensitive' } } } : {}),
    ...(category ? { aiCategory: category } : {}),
    ...(deductible ? deductibleWhereClause(true, deductibleCategories) : {}),
    ...(from || to
      ? {
          createdAt: {
            ...(from ? { gte: new Date(from) } : {}),
            // Include the entire "to" day, not just midnight at its start
            ...(to ? { lte: new Date(new Date(to).setHours(23, 59, 59, 999)) } : {}),
          },
        }
      : {}),
  };
}

// Mirrors buildWalletWhere's filters, but for ScannedReceipt's own field
// shape -- merchantName is a plain string field here (not a Merchant
// relation), and purchaseDate (when the receipt says the purchase
// happened) is what a date-range search should mean, not createdAt (when
// the customer got around to uploading it, which could be much later for
// an old paper receipt).
function buildScannedReceiptWhere(customerId, { search, from, to, category, deductible, deductibleCategories = [] }) {
  return {
    customerId,
    ...(search ? { merchantName: { contains: search, mode: 'insensitive' } } : {}),
    ...(category ? { aiCategory: category } : {}),
    ...(deductible ? deductibleWhereClause(true, deductibleCategories) : {}),
    ...(from || to
      ? {
          purchaseDate: {
            ...(from ? { gte: new Date(from) } : {}),
            ...(to ? { lte: new Date(new Date(to).setHours(23, 59, 59, 999)) } : {}),
          },
        }
      : {}),
  };
}

// GET /account/receipts — every receipt this customer has saved, across ALL
// merchants AND every receipt they've scanned/uploaded themselves, merged
// into one date-sorted list.
// Supports ?search=<business name>, ?from=&to=<date range>, and ?category=<ai category>
// The wallet HOME (/account/receipts) and the full wallet (/account/wallet)
// are the same handler: identical data, two presentations. The home is a
// summary -- setup checklist, month total, the RECENT_RECEIPT_LIMIT most
// recent receipts and a way through to everything. The wallet is the whole
// history with the search, filters and export.
//
// One handler rather than two because every number on both pages comes from
// the same six queries; splitting them would mean two routes computing the
// same month summary and drifting on it.
const RECENT_RECEIPT_LIMIT = 5;

async function renderWallet(req, res, { isFullWallet }) {
  const { search, from, to, category } = req.query;
  // Only '1' turns it on -- an absent or malformed value must mean "no filter",
  // not "show me nothing".
  const deductible = req.query.deductible === '1';

  // Fetched before the parallel block below rather than inside it, because the
  // customer's chosen categories are an INPUT to the where-clauses --
  // deductibility is their rule now, not the model's. One extra round trip on a
  // route that already fought the connection pool, so it selects one column
  // rather than the whole row; the full customer still comes back below.
  const customerRules = await prisma.customer.findUnique({
    where: { id: req.session.customerId },
    select: { deductibleCategories: true },
  });
  const deductibleCategories = customerRules?.deductibleCategories || [];

  const walletFilters = { search, from, to, category, deductible, deductibleCategories };
  const where = buildWalletWhere(req.session.customerId, walletFilters);
  const scanWhere = buildScannedReceiptWhere(req.session.customerId, walletFilters);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  // "Today"/"This week" quick-filter chips -- real date-range links using
  // the same from/to querystring the search form already supports, not a
  // separate filtering mechanism. "This week" is a rolling 7 days (today
  // and the 6 before it), not calendar-week-aligned -- simpler than
  // reasoning about which day a week starts on, and just as meaningful for
  // "what have I bought recently."
  const toISO = (d) => d.toISOString().slice(0, 10);
  const todayDate = new Date();
  const quickFilters = {
    today: { from: toISO(todayDate), to: toISO(todayDate) },
    thisWeek: { from: toISO(new Date(todayDate.getTime() - 6 * 24 * 60 * 60 * 1000)), to: toISO(todayDate) },
    // Calendar month, not a rolling 30 days -- it has to line up with the
    // "This month" total in the summary card above the list, or the same page
    // shows two different answers to the same question.
    thisMonth: {
      from: toISO(new Date(todayDate.getFullYear(), todayDate.getMonth(), 1)),
      to: toISO(todayDate),
    },
  };

  // Six of the ten queries this page used to run exist only because the lists
  // above may be FILTERED, while the month summary, the category chips and the
  // setup counts must always reflect everything. When nothing is filtered --
  // which is how the page is almost always loaded -- the unfiltered lists are
  // already in hand, so those six are the same rows fetched a second time.
  //
  // That mattered more than it looks: Supabase's session pooler allows 15
  // connections in total, and this route alone was firing eleven queries at
  // once (the merchant `include` costs an extra one). They queued against each
  // other, and on a phone over a slow link the wait was plainly visible.
  const isFiltered = Boolean(search || from || to || category || deductible);

  const [customer, transactions, scannedReceipts, partnerAccount] = await Promise.all([
    prisma.customer.findUnique({ where: { id: req.session.customerId } }),
    prisma.transaction.findMany({
      where,
      include: { merchant: true }, // needs merchant business name for display
      orderBy: { createdAt: 'desc' },
    }),
    prisma.scannedReceipt.findMany({ where: scanWhere, orderBy: { createdAt: 'desc' } }),
    // Partner Program step: an affiliate account registered to this shopper's
    // email. Real account state like every other step -- not a "did they visit
    // the page" flag. Affiliate.email is unique, so this is an exact match.
    prisma.customer.findUnique({ where: { id: req.session.customerId }, select: { email: true } })
      .then((c) => (c?.email ? prisma.affiliate.findUnique({ where: { email: c.email }, select: { id: true } }) : null)),
  ]);

  // Filtered? Then the extras genuinely describe a different set of rows and
  // still have to be asked for. Unfiltered? Derive them and skip six round
  // trips.
  const [monthTransactions, monthScanned, categoryRows, scannedCategoryRows, tappedCount, scannedCount] = isFiltered
    ? await Promise.all([
        prisma.transaction.findMany({
          where: { customerId: req.session.customerId, createdAt: { gte: monthStart } },
          select: { total: true, merchantId: true },
        }),
        prisma.scannedReceipt.findMany({
          where: { customerId: req.session.customerId, createdAt: { gte: monthStart } },
          select: { total: true, merchantName: true },
        }),
        prisma.transaction.findMany({
          where: { customerId: req.session.customerId, aiCategory: { not: null } },
          select: { aiCategory: true },
          distinct: ['aiCategory'],
        }),
        prisma.scannedReceipt.findMany({
          where: { customerId: req.session.customerId, aiCategory: { not: null } },
          select: { aiCategory: true },
          distinct: ['aiCategory'],
        }),
        prisma.transaction.count({ where: { customerId: req.session.customerId } }),
        prisma.scannedReceipt.count({ where: { customerId: req.session.customerId } }),
      ])
    : [
        transactions.filter((t) => t.createdAt >= monthStart).map((t) => ({ total: t.total, merchantId: t.merchantId })),
        scannedReceipts.filter((r) => r.createdAt >= monthStart).map((r) => ({ total: r.total, merchantName: r.merchantName })),
        // `distinct` in SQL, deduplicated here -- same set either way.
        [...new Set(transactions.filter((t) => t.aiCategory).map((t) => t.aiCategory))].map((aiCategory) => ({ aiCategory })),
        [...new Set(scannedReceipts.filter((r) => r.aiCategory).map((r) => r.aiCategory))].map((aiCategory) => ({ aiCategory })),
        transactions.length,
        scannedReceipts.length,
      ];

  const monthTotal =
    monthTransactions.reduce((sum, t) => sum + t.total, 0) + monthScanned.reduce((sum, r) => sum + r.total, 0);
  const monthStores = new Set([
    ...monthTransactions.map((t) => t.merchantId),
    ...monthScanned.map((r) => r.merchantName),
  ]).size;

  const merged = [
    ...transactions.map((t) => ({
      id: t.id,
      kind: 'transaction',
      total: (t.total / 100).toFixed(2),
      sortDate: t.createdAt,
      // A tapped receipt's createdAt is a real instant, so it carries a time.
      ...(() => {
        const l = receiptDateLabels(t.createdAt);
        return { month: l.month, date: l.day, time: l.time };
      })(),
      merchantName: t.merchant.businessName,
      aiCategory: t.aiCategory,
      aiTaxDeductible: t.aiTaxDeductible,
      aiReasoning: t.aiReasoning,
      // The effective answer and who gave it -- computed once here so the row,
      // the toggle and the export can't each decide it differently.
      deductible: isDeductible(t, deductibleCategories),
      deductibleSource: deductibleSource(t, deductibleCategories),
      deductibleOverridesRule: overridesCategoryRule(t, deductibleCategories),
      // Same "computed once here" reasoning as deductibility above -- the
      // badge and its inline edit form must never disagree.
      warrantyMonths: effectiveWarrantyMonths(t),
      warrantyExpiresAt: t.warrantyExpiresAt,
      warrantyExpiresLabel: warrantyExpiresLabel(t.warrantyExpiresAt),
      warrantyBadgeText: warrantyBadgeText(t.warrantyExpiresAt, effectiveWarrantyMonths(t)),
      warrantySource: warrantySource(t),
      paymentLabel: cardLabel(t.cardBrand, t.cardLast4, t.paymentMethod),
      autoSaved: t.autoSavedViaRecognition,
      link: `/receipt/${t.id}`,
    })),
    ...scannedReceipts.map((r) => ({
      id: r.id,
      kind: 'scanned',
      total: (r.total / 100).toFixed(2),
      sortDate: r.purchaseDate || r.createdAt,
      // purchaseDate is a pure calendar date (a plain <input type="date">
      // stored as UTC midnight) with no time-of-day meaning, so it's labelled
      // in UTC -- see lib/receiptDateLabels.js for why local would move it.
      // Its only real time is whatever the photo itself printed. With no
      // purchaseDate at all, createdAt is a genuine instant and carries one.
      ...(() => {
        const l = r.purchaseDate
          ? receiptDateLabels(r.purchaseDate, { utc: true, printedTime: r.purchaseTimeText })
          : receiptDateLabels(r.createdAt);
        return { month: l.month, date: l.day, time: l.time };
      })(),
      merchantName: r.merchantName,
      aiCategory: r.aiCategory,
      // These were hardcoded null because ScannedReceipt had no such columns.
      // It does now, so a photographed receipt carries the same answer a
      // tapped one does instead of being silently undeductible.
      aiTaxDeductible: r.aiTaxDeductible,
      aiReasoning: r.aiReasoning,
      deductible: isDeductible(r, deductibleCategories),
      deductibleSource: deductibleSource(r, deductibleCategories),
      deductibleOverridesRule: overridesCategoryRule(r, deductibleCategories),
      warrantyMonths: effectiveWarrantyMonths(r),
      warrantyExpiresAt: r.warrantyExpiresAt,
      warrantyExpiresLabel: warrantyExpiresLabel(r.warrantyExpiresAt),
      warrantyBadgeText: warrantyBadgeText(r.warrantyExpiresAt, effectiveWarrantyMonths(r)),
      warrantySource: warrantySource(r),
      // Already formatted exactly like this by the photo-extraction pass
      // (see the ScannedReceipt.paymentMethod schema comment) -- shown as-is,
      // not reformatted like the tapped-receipt case above.
      paymentLabel: r.paymentMethod || null,
      autoSaved: false, // a scanned receipt was uploaded by hand, never matched
      link: r.imageUrl,
    })),
  ].sort((a, b) => b.sortDate - a.sortDate);

  // The home page's "Recent receipts" is this month, not "the last five ever"
  // -- a customer scrolling their dashboard in January shouldn't be looking
  // at a receipt from October. The full wallet is unaffected; it's still
  // every receipt, which is the whole reason it's a separate page.
  const monthReceipts = merged.filter((r) => r.sortDate >= monthStart);

  const categories = [...new Set([...categoryRows, ...scannedCategoryRows].map((r) => r.aiCategory))].sort();

  // Setup progress -- the shopper equivalent of the merchant checklist on
  // views/business-overview.ejs. Every step is real account state, never a
  // "have they seen this yet" flag: the wallet exists by the time this runs,
  // an account created from a receipt has no password until they set one (or
  // signed in with a provider), and the rest are counts of things they've
  // actually done.
  const setupSteps = {
    walletCreated: true,
    canSignInAnywhere: Boolean(
      customer?.passwordHash || customer?.googleId || customer?.appleId || customer?.microsoftId
    ),
    // Tapped and scanned receipts were two separate steps, which made the
    // checklist look like it wanted both when either one is the milestone:
    // "you have a receipt in here". One step, done by whichever route they took.
    firstReceipt: tappedCount > 0 || scannedCount > 0,
    partnerProgram: Boolean(partnerAccount),
    // Set the first time this account opens ReceipTap from the home screen --
    // the browser reports it, so this is real state like the rest.
    homeScreenAdded: Boolean(customer?.homeScreenAddedAt),
  };
  const setupDone = Object.values(setupSteps).filter(Boolean).length;
  const setup = {
    ...setupSteps,
    percent: Math.round((setupDone / Object.keys(setupSteps).length) * 100),
  };

  res.render('customer-wallet', {
    isFullWallet,
    // The home shows a handful FROM THIS MONTH; the wallet shows everything.
    // Sliced here, not in the query, because the month summary and category
    // chips are built from the same rows and must still count them all.
    receiptsShown: isFullWallet ? merged.length : Math.min(RECENT_RECEIPT_LIMIT, monthReceipts.length),
    // Deliberately all-time, not this-month -- it's what tells the "My
    // Wallet" CTA whether there's more to see, and a customer with receipts
    // from last month but none yet this one still has more to see.
    totalReceiptCount: merged.length,
    customerEmail: customer?.email || '',
    customerName: customer?.name || null,
    setup,
    // Passed rather than written into the template, so the number a customer
    // is promised here can't drift from the one they're actually paid.
    affiliateRate: REGULAR_AFFILIATE_RATE,
    summary: {
      monthTotal: (monthTotal / 100).toFixed(2),
      monthStores,
      monthName: new Date().toLocaleDateString('en-US', { month: 'long' }),
      receiptCount: merged.length,
    },
    categories,
    receipts: isFullWallet ? merged : monthReceipts.slice(0, RECENT_RECEIPT_LIMIT),
    filters: { search: search || '', from: from || '', to: to || '', category: category || '', deductible },
    // The customer's standing rule, and the full list to choose from -- the
    // panel offers every category the model can assign, not only the ones they
    // happen to have receipts in yet.
    deductibleCategories,
    allCategories: CATEGORIES,
    rulesSaved: req.query.rulesSaved === '1',
    quickFilters,
  });
}

router.get('/account/receipts', requireCustomerAuth, (req, res) =>
  renderWallet(req, res, { isFullWallet: false })
);

// The full history, with everything the home page deliberately leaves out.
router.get('/account/wallet', requireCustomerAuth, (req, res) =>
  renderWallet(req, res, { isFullWallet: true })
);

// POST /account/receipts/:kind/:id/deductible — the customer overriding the
// AI on one receipt. Answers JSON so the wallet list can flip a switch in
// place: this is a page you work down marking things before a tax export, and
// a full reload per receipt would make that miserable.
//
// Writes taxDeductible, never aiTaxDeductible: the AI's opinion is kept as it
// was so the two can be compared, and so a later re-categorisation can't
// quietly overwrite a decision the customer made. See lib/receiptDeductible.js.
router.post('/account/receipts/:kind/:id/deductible', requireCustomerAuth, async (req, res) => {
  const { kind, id } = req.params;
  if (kind !== 'transaction' && kind !== 'scanned') {
    return res.status(404).json({ error: 'Unknown receipt type' });
  }

  // Tri-state on purpose: 'clear' hands the receipt back to the AI's
  // suggestion rather than freezing today's answer as a customer decision.
  const raw = req.body?.deductible;
  const value = raw === 'clear' || raw === null ? null : raw === true || raw === 'true';

  const model = kind === 'transaction' ? prisma.transaction : prisma.scannedReceipt;

  // Ownership is checked by filtering on customerId rather than by reading the
  // row and comparing: a receipt id is a cuid, guessable enough that "update
  // where id" alone would let one customer relabel another's receipt.
  const { count } = await model.updateMany({
    where: { id, customerId: req.session.customerId },
    data: { taxDeductible: value },
  });
  if (count === 0) return res.status(404).json({ error: 'Not found' });

  const [updated, rules] = await Promise.all([
    model.findUnique({ where: { id }, select: { taxDeductible: true, aiCategory: true } }),
    prisma.customer.findUnique({
      where: { id: req.session.customerId },
      select: { deductibleCategories: true },
    }),
  ]);
  const cats = rules?.deductibleCategories || [];

  res.json({
    deductible: isDeductible(updated, cats),
    source: deductibleSource(updated, cats),
    overridesRule: overridesCategoryRule(updated, cats),
    category: updated.aiCategory || null,
  });
});

// POST /account/receipts/:kind/:id/warranty — the customer correcting the
// AI's warranty-length estimate on one receipt (they bought AppleCare, or
// the guess was for the wrong item). See lib/receiptWarranty.js.
router.post('/account/receipts/:kind/:id/warranty', requireCustomerAuth, async (req, res) => {
  const { kind, id } = req.params;
  if (kind !== 'transaction' && kind !== 'scanned') {
    return res.status(404).json({ error: 'Unknown receipt type' });
  }

  // Tri-state, same reasoning as the deductible route: 'clear' hands the
  // receipt back to the AI's estimate rather than freezing today's number.
  // 0 is a real answer ("no warranty"), not treated as falsy/absent.
  const raw = req.body?.months;
  let months;
  if (raw === 'clear' || raw === null || raw === undefined || raw === '') {
    months = null;
  } else {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return res.status(400).json({ error: 'months must be a non-negative whole number' });
    }
    months = parsed;
  }

  const model = kind === 'transaction' ? prisma.transaction : prisma.scannedReceipt;

  // Ownership via updateMany, same reasoning as the deductible route above:
  // a receipt id is a guessable cuid.
  // purchaseDate only exists on ScannedReceipt -- Transaction has no such
  // column (createdAt IS the purchase moment there), so the select can't be
  // shared verbatim between the two models the way the rest of this route is.
  const existing = await model.findFirst({
    where: { id, customerId: req.session.customerId },
    select:
      kind === 'scanned'
        ? { createdAt: true, purchaseDate: true, aiWarrantyMonths: true, warrantyExpiresAt: true }
        : { createdAt: true, aiWarrantyMonths: true, warrantyExpiresAt: true },
  });
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const purchaseDate = kind === 'scanned' ? existing.purchaseDate || existing.createdAt : existing.createdAt;
  const effectiveMonths = effectiveWarrantyMonths({ aiWarrantyMonths: existing.aiWarrantyMonths, warrantyMonths: months });
  const newExpiry = computeWarrantyExpiry(purchaseDate, effectiveMonths);

  // Reset both reminder flags whenever the effective expiry actually
  // changes -- a stale "already sent" flag from the wrong original date
  // would otherwise silently suppress the reminder for the corrected one.
  const expiryChanged = String(existing.warrantyExpiresAt) !== String(newExpiry);

  const { count } = await model.updateMany({
    where: { id, customerId: req.session.customerId },
    data: {
      warrantyMonths: months,
      warrantyExpiresAt: newExpiry,
      ...(expiryChanged ? { warranty14dReminderSentAt: null, warranty3dReminderSentAt: null } : {}),
    },
  });
  if (count === 0) return res.status(404).json({ error: 'Not found' });

  res.json({
    warrantyMonths: effectiveMonths,
    warrantyExpiresAt: newExpiry,
    source: warrantySource({ aiWarrantyMonths: existing.aiWarrantyMonths, warrantyMonths: months }),
  });
});

// POST /account/receipts/deductible-categories — the customer setting which of
// their categories count as tax deductible.
//
// This is the primary mechanism now. The AI says what was bought; whether that
// is claimable depends on who is filing, which only they know. See the note at
// the top of lib/receiptDeductible.js.
//
// Stored as a whitelist rather than per-category rows: it's one small set the
// customer edits as a whole, and a set makes "nothing is deductible" (the
// default) representable without a special case.
router.post('/account/receipts/deductible-categories', requireCustomerAuth, async (req, res) => {
  // A form posts one value per ticked box, so a single tick arrives as a
  // string and none at all as undefined -- both have to mean a valid set.
  const raw = req.body?.categories;
  const submitted = Array.isArray(raw) ? raw : raw == null ? [] : [raw];

  // Only categories the model actually assigns are accepted. Without this the
  // field would take arbitrary strings from the form, and a typo would be a
  // rule that silently matches nothing.
  const allowed = new Set(CATEGORIES);
  const categories = [...new Set(submitted.filter((c) => allowed.has(c)))];

  await prisma.customer.update({
    where: { id: req.session.customerId },
    data: { deductibleCategories: categories },
  });

  res.redirect('/account/wallet?deductible=1&rulesSaved=1');
});

// GET /account/receipts/export — CSV of whatever the wallet's current filters match
//
// Includes SCANNED receipts as well as tapped ones. It used to export only
// transactions, so a customer who photographed their paper receipts got a tax
// export missing exactly the receipts they'd gone to the trouble of capturing.
router.get('/account/receipts/export', requireCustomerAuth, async (req, res) => {
  const { search, from, to, category } = req.query;
  const deductible = req.query.deductible === '1';
  const rules = await prisma.customer.findUnique({
    where: { id: req.session.customerId },
    select: { deductibleCategories: true },
  });
  const deductibleCategories = rules?.deductibleCategories || [];
  const f = { search, from, to, category, deductible, deductibleCategories };
  const where = buildWalletWhere(req.session.customerId, f);
  const scanWhere = buildScannedReceiptWhere(req.session.customerId, f);

  const [transactions, scanned] = await Promise.all([
    prisma.transaction.findMany({ where, include: { merchant: true }, orderBy: { createdAt: 'desc' } }),
    prisma.scannedReceipt.findMany({ where: scanWhere, orderBy: { createdAt: 'desc' } }),
  ]);

  const rows = [
    ...transactions.map((t) => ({
      id: t.id,
      kind: 'tapped',
      date: t.createdAt,
      business: t.merchant.businessName,
      total: t.total,
      category: t.aiCategory,
      row: t,
    })),
    ...scanned.map((r) => ({
      id: r.id,
      kind: 'scanned',
      date: r.purchaseDate || r.createdAt,
      business: r.merchantName,
      total: r.total,
      category: r.aiCategory,
      row: r,
    })),
  ].sort((a, b) => b.date - a.date);

  const header = 'receipt_id,type,date,business,total,category,tax_deductible,decided_by';
  const csv = [header]
    .concat(
      rows.map((r) =>
        [
          r.id,
          r.kind,
          r.date.toISOString(),
          csvCell(r.business),
          (r.total / 100).toFixed(2),
          csvCell(r.category || ''),
          isDeductible(r.row, deductibleCategories) ? 'yes' : 'no',
          // receipt | category | none -- an accountant can see which rows the
          // customer ruled on directly and which follow a category rule.
          deductibleSource(r.row, deductibleCategories),
        ].join(',')
      )
    )
    .join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="receiptap-${deductible ? 'tax-deductible' : 'my'}-receipts.csv"`
  );
  res.send(csv);
});

// --- Scan a receipt (photo/upload -> AI-extracted draft -> customer confirms) ---

router.get('/account/receipts/scan', requireCustomerAuth, (req, res) => {
  res.render('scan-receipt', { error: req.query.error || null });
});

// Uploads the photo, asks Claude to read it, and shows the (possibly
// partial, possibly empty) result for the customer to confirm or correct —
// nothing is saved to their wallet yet. A failed/unclear read just means
// an empty form, not an error, since the customer can always type it in
// by hand.
// The scanned-receipt detail fields, in one place so the upload render, the
// error re-render, and the save can't drift apart on which ones exist.
const SCAN_DETAIL_FIELDS = ['merchantAddress', 'subtotal', 'tax', 'tip', 'currency', 'taxNumber',
  // Added for tax substantiation -- a second registration number (QST/PST
  // alongside GST/HST), the buyer's name CRA wants above $150, the printed
  // time, and the customer's own note on what the spend was for.
  'taxNumber2', 'buyerName', 'purchaseTimeText', 'businessPurpose'];

function centsToInput(cents) {
  return cents != null ? (cents / 100).toFixed(2) : '';
}

router.post('/account/receipts/scan', requireCustomerAuth, handleReceiptScanUpload, async (req, res) => {
  if (!req.file) return res.redirect('/account/receipts/scan?error=' + encodeURIComponent('Please choose a photo to upload.'));

  // Stored first, so the review page's <img> has something to point at, and
  // so a photo is never left only in memory. Extraction reads the same buffer
  // rather than re-fetching what was just written.
  let imageUrl;
  try {
    imageUrl = await fileStorage.put('receipt-scans', req.file, { prefix: req.session.customerId });
  } catch (err) {
    console.error('[scan] storing the photo failed:', err.message);
    return res.redirect('/account/receipts/scan?error=' + encodeURIComponent("We couldn't save that photo — please try again."));
  }
  const extracted = await extractReceiptData(req.file.buffer, req.file.mimetype);

  res.render('scan-receipt-review', {
    imageUrl,
    duplicate: null,
    couldNotRead: !extracted,
    merchantName: extracted?.merchantName || '',
    date: extracted?.date || '',
    total: extracted?.totalCents != null ? (extracted.totalCents / 100).toFixed(2) : '',
    category: extracted?.category || '',
    lineItems: extracted?.lineItems ? JSON.stringify(extracted.lineItems) : '[]',
    paymentMethod: extracted?.paymentMethod || '',
    receiptNumber: extracted?.receiptNumber || '',
    // Everything else the paper printed. Shown for confirmation like the rest
    // -- the customer is looking at the photo, so they can correct a misread
    // tax line as easily as a misread total.
    merchantAddress: extracted?.merchantAddress || '',
    subtotal: centsToInput(extracted?.subtotalCents),
    tax: centsToInput(extracted?.taxCents),
    tip: centsToInput(extracted?.tipCents),
    currency: extracted?.currency || '',
    taxNumber: extracted?.taxNumber || '',
    taxNumber2: extracted?.taxNumber2 || '',
    buyerName: extracted?.buyerName || '',
    purchaseTimeText: extracted?.timeText || '',
    // Never extracted -- it isn't printed anywhere. Always starts blank for
    // the customer to fill in if they want to.
    businessPurpose: '',
    categories: CATEGORIES,
  });
});

router.post('/account/receipts/scan/confirm', requireCustomerAuth, async (req, res) => {
  const { imageUrl, merchantName, date, total, category, lineItems, paymentMethod, receiptNumber } = req.body;

  // Re-renders the review page with whatever they had typed still in place --
  // losing a hand-corrected total to an error message would be its own bug.
  const backToReview = (error, duplicate = null) =>
    res.render('scan-receipt-review', {
      imageUrl,
      duplicate,
      couldNotRead: false,
      merchantName: merchantName || '',
      date: date || '',
      total: total || '',
      category: category || '',
      lineItems: lineItems || '[]',
      paymentMethod: paymentMethod || '',
      receiptNumber: receiptNumber || '',
      ...Object.fromEntries(SCAN_DETAIL_FIELDS.map((f) => [f, req.body[f] || ''])),
      categories: CATEGORIES,
      error,
    });

  if (!imageUrl || !merchantName || !total) {
    return backToReview('Merchant name and total are required.');
  }

  const totalCents = parseMoneyToCents(total);
  if (totalCents === null) {
    return backToReview(`"${String(total).slice(0, 20)}" isn't an amount we can read — enter it like 12.34`);
  }

  let parsedLineItems = [];
  try {
    parsedLineItems = JSON.parse(lineItems || '[]');
  } catch {
    parsedLineItems = [];
  }

  // Already got this one? Warn once, then respect their answer. Checked here
  // rather than when the review page first rendered, because the customer may
  // have corrected the merchant, total or date in between -- and those three
  // are exactly what the match is made on.
  if (req.body.confirmDuplicate !== '1') {
    const duplicate = await findDuplicateReceipt({
      customerId: req.session.customerId,
      merchantName,
      totalCents,
      purchaseDate: parseDateOrNull(date),
    });
    if (duplicate) return backToReview(null, duplicate);
  }

  let saved;
  try {
    saved = await prisma.scannedReceipt.create({
      data: {
        customerId: req.session.customerId,
        imageUrl,
        merchantName: merchantName.trim().slice(0, 200),
        purchaseDate: parseDateOrNull(date),
        total: totalCents,
        aiCategory: category || null,
        lineItems: parsedLineItems,
        paymentMethod: paymentMethod ? paymentMethod.trim().slice(0, 60) : null,
        receiptNumber: receiptNumber ? receiptNumber.trim().slice(0, 60) : null,
        // Same tolerant parsing as the total -- a "$" or comma typed into any
        // of these must not become NaN and take the whole save down with it.
        subtotal: parseMoneyToCents(req.body.subtotal),
        tax: parseMoneyToCents(req.body.tax),
        tip: parseMoneyToCents(req.body.tip),
        currency: /^[A-Za-z]{3}$/.test((req.body.currency || '').trim())
          ? req.body.currency.trim().toUpperCase()
          : null,
        taxNumber: req.body.taxNumber ? req.body.taxNumber.trim().slice(0, 40) : null,
        taxNumber2: req.body.taxNumber2 ? req.body.taxNumber2.trim().slice(0, 40) : null,
        buyerName: req.body.buyerName ? req.body.buyerName.trim().slice(0, 200) : null,
        purchaseTimeText: req.body.purchaseTimeText ? req.body.purchaseTimeText.trim().slice(0, 20) : null,
        businessPurpose: req.body.businessPurpose ? req.body.businessPurpose.trim().slice(0, 300) : null,
        merchantAddress: req.body.merchantAddress ? req.body.merchantAddress.trim().slice(0, 200) : null,
      },
    });
  } catch (err) {
    // Anything else -- a dropped connection, a column constraint -- must still
    // answer the request. Hanging is the worst possible failure here: the
    // customer is left holding a receipt they think they've lost.
    console.error('[scan] saving a scanned receipt failed:', err.message);
    return backToReview("We couldn't save that receipt just now — please try again.");
  }

  // Deductibility, in the background. The extraction pass reads the photo for
  // a category; this asks the separate question a tax export depends on, and
  // like every other categorisation it must never block or fail the save.
  categorizeScannedInBackground(saved);

  // The Alerts tab is the wallet's record of what happened to it. Failing to
  // write the note must never undo a receipt that saved fine.
  try {
    await notifyReceiptSaved({
      customerId: req.session.customerId,
      merchantName: saved.merchantName,
      totalCents: saved.total,
    });
  } catch (err) {
    console.error('[scan] receipt-saved notification failed:', err.message);
  }

  res.redirect('/account/receipts');
});

// DELETE a scanned receipt. Only ever a SCANNED one: a tapped receipt is the
// merchant's record of a real sale as well as the customer's copy, so removing
// it from a wallet is an unlink, not a delete -- a different operation that
// belongs with the merchant-facing data-retention paths, not here.
// The digital receipt for a scanned photo. Everything the extraction pass
// captured was stored and then shown nowhere -- eight of the thirteen fields
// were invisible, so the only way to read a subtotal or a tax number was to
// open the picture. For a receipt someone is keeping in order to claim it
// back, that is backwards.
router.get('/account/receipts/scanned/:id', requireCustomerAuth, async (req, res) => {
  const receipt = await prisma.scannedReceipt.findUnique({ where: { id: req.params.id } });

  // Same answer whether it never existed or belongs to someone else -- this
  // must not become a way to probe for other people's receipt IDs.
  if (!receipt || receipt.customerId !== req.session.customerId) {
    return res.redirect('/account/receipts');
  }

  const items = Array.isArray(receipt.lineItems) ? receipt.lineItems : [];

  // Say plainly which record-keeping fields this receipt does not carry.
  // Someone relying on it at tax time should learn that here, not from an
  // auditor. Deliberately limited to fields a receipt is normally expected
  // to print -- a missing tip line on a clothing purchase is not a gap.
  const missing = [];
  if (!receipt.taxNumber) missing.push('a tax registration number');
  if (!receipt.receiptNumber) missing.push('a receipt number');
  if (!receipt.paymentMethod) missing.push('how it was paid');
  if (!receipt.purchaseTimeText) missing.push('the time of day');
  // CRA only requires the buyer be named once a purchase reaches $150, so
  // flagging it below that would be noise on almost every till receipt.
  if (!receipt.buyerName && receipt.total >= 15000) missing.push('the buyer\'s name (CRA asks for it over $150)');

  const whenParts = [
    receipt.purchaseDate
      ? receipt.purchaseDate.toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' })
      : 'Date not recorded',
    receipt.purchaseTimeText,
  ].filter(Boolean);

  res.render('scanned-receipt', {
    receipt,
    items,
    missing,
    whenLabel: whenParts.join(' · '),
    money: (cents) => (cents / 100).toFixed(2),
  });
});

// The customer's own note on why they bought it -- the one thing on this page
// that never came off the paper. Editable after the fact because the reason
// is often clearer a week later than it was at the till.
router.post('/account/receipts/scanned/:id/purpose', requireCustomerAuth, async (req, res) => {
  const receipt = await prisma.scannedReceipt.findUnique({ where: { id: req.params.id } });
  if (!receipt || receipt.customerId !== req.session.customerId) {
    return res.redirect('/account/receipts');
  }
  const note = typeof req.body.businessPurpose === 'string' ? req.body.businessPurpose.trim().slice(0, 300) : '';
  await prisma.scannedReceipt.update({
    where: { id: receipt.id },
    data: { businessPurpose: note || null },
  });
  res.redirect('/account/receipts/scanned/' + receipt.id);
});

router.post('/account/receipts/scanned/:id/delete', requireCustomerAuth, async (req, res) => {
  const receipt = await prisma.scannedReceipt.findUnique({ where: { id: req.params.id } });

  // Same answer whether it never existed or belongs to someone else -- this
  // must not become a way to probe for other people's receipt IDs.
  if (!receipt || receipt.customerId !== req.session.customerId) {
    return res.redirect('/account/receipts');
  }

  await prisma.scannedReceipt.delete({ where: { id: receipt.id } });

  // The photo goes too. Leaving it behind would keep an image of someone's
  // receipt after they asked for it to be gone. fileStorage handles either
  // backend, including files written before remote storage was switched on.
  await fileStorage.remove(receipt.imageUrl);

  try {
    await notifyReceiptDeleted({
      customerId: req.session.customerId,
      merchantName: receipt.merchantName,
      totalCents: receipt.total,
    });
  } catch (err) {
    console.error('[scan] receipt-deleted notification failed:', err.message);
  }

  res.redirect('/account/receipts');
});

// GET /account/settings — update display name or password. Deliberately
// just those two for now, not account/data deletion -- deleteShopperEverywhere()
// (services/dataRetentionService.js) exists and works but has no UI yet;
// that's a separate, bigger addition than what was asked for here.
router.get('/account/settings', requireCustomerAuth, async (req, res) => {
  const [customer, identifiers] = await Promise.all([
    prisma.customer.findUnique({ where: { id: req.session.customerId } }),
    // Live links only -- a revoked one is kept for audit but is not something
    // the shopper still has switched on, so showing it would misrepresent
    // what's actually active.
    listIdentifiersForShopper(req.session.customerId),
  ]);

  // Deliberately never exposes identifierValueHash. It's a pseudonymous
  // pointer to a real payment card; a shopper needs to know a link EXISTS and
  // be able to end it, not to see the value itself.
  const recognitionLinks = identifiers.map((i) => ({
    id: i.id,
    platform: i.sourcePlatform,
    linkedOn: i.createdAt.toLocaleDateString('en-US', { dateStyle: 'medium' }),
  }));

  res.render('customer-settings', {
    customer,
    recognitionLinks,
    // One save for the whole preferences form now -- see the comment above the
    // form in views/customer-settings.ejs.
    prefsSuccess: req.query.saved === '1',
    profileError: req.query.profileError || null,
    passwordError: req.query.passwordError || null,
    passwordSuccess: req.query.passwordSuccess === '1',
    recognitionRevoked: req.query.recognitionRevoked === '1',
  });
});

// POST /account/settings/auto-save — the shopper choosing whether tapping a
// puck saves the receipt by itself. Posted from a form rather than toggled
// live, so the stored value always matches what they last confirmed.
// Profile name and both notification preferences save together -- the page
// presents them as one form with one button, so splitting the write across
// three endpoints would just be three round trips and three chances for one
// of them to fail on its own.
//
// Both checkboxes are read as "present means on": an unchecked box submits
// nothing at all, which is exactly how a single form expresses false.
//
// Login email lives in this same form/route now too -- it's account-level,
// same as name and phone, and splitting it into its own Save button would
// undercut the "one form, one button" reasoning above just for this field.
router.post('/account/settings/preferences', requireCustomerAuth, async (req, res) => {
  const fail = (msg) => res.redirect('/account/settings?profileError=' + encodeURIComponent(msg));

  const email = (req.body.email || '').trim().toLowerCase();
  if (!email) return fail('Email is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Enter a valid email address.');
  const clash = await prisma.customer.findFirst({
    where: { email, NOT: { id: req.session.customerId } },
  });
  if (clash) return fail('That email is already in use by another account.');

  await prisma.customer.update({
    where: { id: req.session.customerId },
    data: {
      email,
      name: (req.body.name || '').trim() || null,
      phone: (req.body.phone || '').trim() || null,
      autoSaveOnTap: req.body.autoSaveOnTap === 'on',
      loyaltyEmails: req.body.loyaltyEmails === 'on',
    },
  });
  res.redirect('/account/settings?saved=1');
});

// POST /account/settings/recognition/revoke — the shopper turning off
// cross-merchant recognition, which the consent label on the Save Receipt
// modal explicitly promises ("I can turn this off anytime").
//
// Revokes every live identifier at once rather than one at a time: from the
// shopper's side this is a single decision ("stop recognising me"), not a
// per-card inventory they should have to reason about. Soft revocation --
// the rows survive so a later DSAR can still show a link existed and when it
// ended; only a full account deletion removes them.
router.post('/account/settings/recognition/revoke', requireCustomerAuth, async (req, res) => {
  const shopperId = req.session.customerId;
  const live = await listIdentifiersForShopper(shopperId);
  for (const row of live) {
    await revokeIdentifierByHash(shopperId, row.identifierType, row.identifierValueHash, row.sourcePlatform);
  }
  res.redirect('/account/settings?recognitionRevoked=1');
});

// A customer who signed up via Google/Apple/Microsoft has no passwordHash
// yet -- current-password verification only applies if one already
// exists, otherwise this is "set a password for the first time" rather
// than "change" one, same account either way.
router.post('/account/settings/password', requireCustomerAuth, async (req, res) => {
  const { currentPassword, newPassword, confirmNewPassword } = req.body;
  const customer = await prisma.customer.findUnique({ where: { id: req.session.customerId } });

  if (customer.passwordHash) {
    const currentOk = currentPassword && (await bcrypt.compare(currentPassword, customer.passwordHash));
    if (!currentOk) {
      return res.redirect('/account/settings?passwordError=' + encodeURIComponent('Current password is incorrect.'));
    }
  }
  if (!newPassword || newPassword.length < 8) {
    return res.redirect('/account/settings?passwordError=' + encodeURIComponent('New password must be at least 8 characters.'));
  }
  if (newPassword !== confirmNewPassword) {
    return res.redirect('/account/settings?passwordError=' + encodeURIComponent('New passwords do not match.'));
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.customer.update({ where: { id: req.session.customerId }, data: { passwordHash } });
  res.redirect('/account/settings?passwordSuccess=1');
});

// POST /account/settings/delete — self-serve full account erasure, using
// the already-built deleteShopperEverywhere() (services/dataRetentionService.js)
// which previously had no UI anywhere. Unlike merchant deactivation
// (routes/account-settings.js), which starts a grace-period countdown
// before data is actually purged, this is immediate and permanent -- no
// grace period, no self-serve undo -- since dryRun:false there really does
// delete the Customer row and unlink every Transaction in one shot. The
// view warns about this plainly before the confirming click, same
// reasoning as the merchant deactivation modal it's modeled on.
router.post('/account/settings/delete', requireCustomerAuth, async (req, res) => {
  const customer = await prisma.customer.findUnique({ where: { id: req.session.customerId } });
  if (!customer) return res.redirect('/account/login');

  await deleteShopperEverywhere(customer.email, { dryRun: false });

  req.session.destroy(() => {
    res.redirect('/account/login?deleted=1');
  });
});

// GET /account/more — the wallet's account/menu page, reached from the
// bottom tab bar.
//
// Personal/Business toggle: a wallet (Customer) account and a merchant
// account are entirely separate logins in this app -- there's no unified
// account to switch a "mode" on, unlike the reference design this page's
// layout borrows from. "Business" here is a real navigation shortcut, not
// a fake unlockable mode: it looks up whether a Merchant row already
// exists at this customer's own email (best-effort association -- nothing
// links the two tables, a person could easily use a different email for
// each, hence the "sign up as a merchant" escape hatch in the view) and
// either points them at that real account or offers real merchant signup.
router.get('/account/more', requireCustomerAuth, async (req, res) => {
  const customer = await prisma.customer.findUnique({ where: { id: req.session.customerId } });
  const view = req.query.view === 'business' ? 'business' : 'personal';

  // Both sessions can be live in one browser at once, and when they are the
  // toggle should just switch. Only fall through to the explain-and-sign-in
  // card below when there's no merchant session to switch INTO -- otherwise
  // someone signed into both got stranded on an informational card telling
  // them about an account they were already logged into.
  if (view === 'business' && req.session.merchantId) {
    return res.redirect('/account/business/more');
  }

  let merchantStatus = null;
  if (view === 'business' && customer?.email) {
    const merchant = await prisma.merchant.findUnique({ where: { email: customer.email } });
    merchantStatus = merchant
      ? {
          exists: true,
          email: merchant.email,
          loggedIn: req.session.merchantId === merchant.id,
          subscriptionStatus: merchant.subscriptionStatus,
        }
      : { exists: false };
  }

  // Partner Program row: an affiliate signed in here goes straight to their
  // earnings, anyone else to the page that explains the programme. Sending a
  // non-affiliate at /affiliate/dashboard would bounce them to a login form
  // for an account they don't have yet, which is a poor first thing to see.
  const isAffiliate = Boolean(req.session?.affiliateId);

  res.render('account-more', {
    customerEmail: customer?.email || '',
    view,
    merchantStatus,
    isAffiliate,
  });
});

// GET /account/spending — real spending analytics from this customer's own
// data: this month's total, a 6-month trend, and a category breakdown over
// that same 6-month window. Merges Transaction (real POS taps) and
// ScannedReceipt (self-uploaded) the same way GET /account/receipts does.
router.get('/account/spending', requireCustomerAuth, async (req, res) => {
  const customerId = req.session.customerId;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const sixMonthStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const [monthTxns, monthScanned, rangeTxns, rangeScanned] = await Promise.all([
    prisma.transaction.findMany({ where: { customerId, createdAt: { gte: monthStart } }, select: { total: true } }),
    prisma.scannedReceipt.findMany({ where: { customerId, createdAt: { gte: monthStart } }, select: { total: true } }),
    prisma.transaction.findMany({
      where: { customerId, createdAt: { gte: sixMonthStart } },
      select: { total: true, createdAt: true, aiCategory: true },
    }),
    prisma.scannedReceipt.findMany({
      where: { customerId, createdAt: { gte: sixMonthStart } },
      select: { total: true, purchaseDate: true, createdAt: true, aiCategory: true },
    }),
  ]);

  const monthTotal = monthTxns.reduce((sum, t) => sum + t.total, 0) + monthScanned.reduce((sum, r) => sum + r.total, 0);

  // 6 fixed month buckets (oldest to newest, including the current month),
  // rather than only the months that happen to have data -- so a customer
  // with 2 months of history still sees a real 6-month axis, just mostly
  // flat.
  const monthBuckets = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthBuckets.push({ year: d.getFullYear(), month: d.getMonth(), label: d.toLocaleDateString('en-US', { month: 'short' }), cents: 0 });
  }
  function bucketFor(date) {
    return monthBuckets.find((b) => b.year === date.getFullYear() && b.month === date.getMonth());
  }
  rangeTxns.forEach((t) => {
    const b = bucketFor(t.createdAt);
    if (b) b.cents += t.total;
  });
  rangeScanned.forEach((r) => {
    const b = bucketFor(r.purchaseDate || r.createdAt);
    if (b) b.cents += r.total;
  });
  const hasMonthlyData = monthBuckets.some((b) => b.cents > 0);

  // Category breakdown over the same 6-month window -- only receipts an AI
  // pass actually categorized count toward this; uncategorized ones are
  // left out rather than lumped into a fake "Other" bucket.
  const categoryTotals = {};
  [...rangeTxns, ...rangeScanned].forEach((r) => {
    if (!r.aiCategory) return;
    categoryTotals[r.aiCategory] = (categoryTotals[r.aiCategory] || 0) + r.total;
  });
  const categorySum = Object.values(categoryTotals).reduce((a, b) => a + b, 0);
  const byCategory = Object.entries(categoryTotals)
    .map(([name, cents]) => ({ name, total: (cents / 100).toFixed(2), pct: categorySum ? Math.round((cents / categorySum) * 100) : 0 }))
    .sort((a, b) => parseFloat(b.total) - parseFloat(a.total));

  res.render('account-spending', {
    summary: {
      monthTotal: (monthTotal / 100).toFixed(2),
      receiptCount: monthTxns.length + monthScanned.length,
    },
    monthlySpending: monthBuckets.map((b) => ({ label: b.label, total: (b.cents / 100).toFixed(2) })),
    hasMonthlyData,
    byCategory,
  });
});

// POST /account/logout — clears only the customer session (a person could be
// logged in as a merchant in the same browser; don't log them out of that too)
router.post('/account/logout', (req, res) => {
  delete req.session.customerId;
  res.redirect('/account/login');
});

module.exports = router;
