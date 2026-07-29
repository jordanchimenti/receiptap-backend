// routes/theme-settings.js
// Where a merchant sets everything that drives their receipt's appearance,
// including the Google review link used by the "Rate us on Google" card.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const prisma = require('../lib/prisma');

function requireAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

// Logo uploads -- stored on local disk under public/, served the same way
// public/images/receiptap-logo.png already is. NOTE: local disk storage only
// works because this app isn't deployed anywhere yet. Most hosting platforms
// wipe local files on every redeploy, so this needs to move to real object
// storage (S3 / Supabase Storage) before going to production.
const LOGO_DIR = path.join(__dirname, '..', 'public', 'uploads', 'logos');
fs.mkdirSync(LOGO_DIR, { recursive: true });

const ALLOWED_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

const uploadLogo = multer({
  storage: multer.diskStorage({
    destination: LOGO_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${req.session.merchantId}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_LOGO_TYPES.includes(file.mimetype)) {
      return cb(new Error('INVALID_LOGO_TYPE'));
    }
    cb(null, true);
  },
}).single('logoFile');

// Wraps multer so a bad upload re-renders the settings page with a real
// error message instead of a generic Express error page.
function handleLogoUpload(req, res, next) {
  uploadLogo(req, res, async (err) => {
    if (!err) return next();

    const [theme, merchant] = await Promise.all([
      prisma.receiptTheme.findUnique({ where: { merchantId: req.session.merchantId } }),
      prisma.merchant.findUnique({ where: { id: req.session.merchantId } }),
    ]);
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Logo file is too large (2MB max).'
        : 'Please upload a valid image file (PNG, JPG, WEBP, or SVG).';

    res.status(400).render('theme-settings', {
      merchant,
      theme: theme || { layoutId: 'classic', primaryColor: '#111111', accentColor: '#2563eb', showWalletSave: true },
      saved: false,
      error: message,
    });
  });
}

router.get('/dashboard/settings/receipt', requireAuth, async (req, res) => {
  const [theme, merchant] = await Promise.all([
    prisma.receiptTheme.findUnique({ where: { merchantId: req.session.merchantId } }),
    prisma.merchant.findUnique({ where: { id: req.session.merchantId } }),
  ]);

  res.render('theme-settings', {
    merchant,
    theme: theme || {
      layoutId: 'classic',
      logoUrl: '',
      displayName: '',
      location: '',
      primaryColor: '#111111',
      accentColor: '#2563eb',
      headerText: '',
      footerText: '',
      showGoogleReview: false,
      googleReviewUrl: '',
      showWarranty: false,
      showLoyalty: false,
      showWalletSave: true,
    },
    saved: false,
    error: null,
  });
});

// A live, isolated preview of any layout + the merchant's own colors/branding —
// rendered with sample data so they can compare before committing. Reuses the
// exact same receipt.ejs shell + layout partials real customers see, so the
// preview can never drift out of sync with the real thing.
router.get('/dashboard/settings/receipt/preview/:layoutId', requireAuth, async (req, res) => {
  const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
  const savedTheme = await prisma.receiptTheme.findUnique({ where: { merchantId: req.session.merchantId } });

  // Query params reflect the merchant's live, unsaved edits (sent by the
  // settings page's JS) -- fall back to the saved theme, then a sane
  // default, so the preview is accurate whether or not a param was sent.
  const bool = (param, fallback) => (param === undefined ? fallback : param === 'true');

  const previewTheme = {
    ...(savedTheme || { primaryColor: '#111111', accentColor: '#2563eb' }),
    layoutId: req.params.layoutId,
    primaryColor: req.query.primaryColor || (savedTheme && savedTheme.primaryColor) || '#111111',
    accentColor: req.query.accentColor || (savedTheme && savedTheme.accentColor) || '#2563eb',
    headerText: req.query.headerText || (savedTheme && savedTheme.headerText) || 'Thanks for stopping by!',
    footerText: req.query.footerText || (savedTheme && savedTheme.footerText) || '',
    logoUrl: req.query.logoUrl || (savedTheme && savedTheme.logoUrl) || null,
    displayName: req.query.displayName || (savedTheme && savedTheme.displayName) || '',
    location: req.query.location || (savedTheme && savedTheme.location) || '',
    googleReviewUrl: req.query.googleReviewUrl || (savedTheme && savedTheme.googleReviewUrl) || '',
    showGoogleReview: bool(req.query.showGoogleReview, Boolean(savedTheme && savedTheme.showGoogleReview)),
    showWarranty: bool(req.query.showWarranty, Boolean(savedTheme && savedTheme.showWarranty)),
    showLoyalty: bool(req.query.showLoyalty, Boolean(savedTheme && savedTheme.showLoyalty)),
    showWalletSave: bool(req.query.showWalletSave, savedTheme ? Boolean(savedTheme.showWalletSave) : true),
  };

  res.render('receipt', {
    merchant,
    theme: previewTheme,
    googleClientId: '', // no need to render a live Google button inside a preview thumbnail
    transaction: {
      id: 'preview',
      date: 'Jul 18, 2026, 2:45 PM',
      lineItems: [
        { name: 'Sample Item', quantity: 2, total: 900 },
        { name: 'Another Item', quantity: 1, total: 450 },
      ],
      subtotal: '13.50',
      tax: '1.76',
      total: '15.26',
      paymentMethod: 'Visa ••••4242',
    },
    // This is a layout-picker preview, not a real receipt -- the merchant's
    // real logo/name still show once set (so the preview reflects reality),
    // but before a logo is uploaded, show a "Custom Logo" placeholder box
    // instead of just leaving that space blank.
    isPreview: true,
  });
});

router.post('/dashboard/settings/receipt', requireAuth, handleLogoUpload, async (req, res) => {
  const {
    layoutId, primaryColor, accentColor, headerText, footerText, displayName, location,
    googleReviewUrl, showGoogleReview, showWarranty, showLoyalty, showWalletSave,
  } = req.body;

  const safeLayoutId = ['classic', 'modern', 'minimal'].includes(layoutId) ? layoutId : 'classic';
  const [existingTheme, merchant] = await Promise.all([
    prisma.receiptTheme.findUnique({ where: { merchantId: req.session.merchantId } }),
    prisma.merchant.findUnique({ where: { id: req.session.merchantId } }),
  ]);

  // A new upload wins; otherwise keep whatever was already saved -- a file
  // input never re-submits its old value, so leaving this alone would
  // silently wipe the logo on every save.
  let logoUrl = existingTheme ? existingTheme.logoUrl : null;
  if (req.file) {
    logoUrl = `/uploads/logos/${req.file.filename}`;
  }

  // If they've turned the review toggle on, require a real, well-formed URL —
  // this is the link customers will actually be sent to, so it has to work.
  if (showGoogleReview === 'on') {
    if (!googleReviewUrl || !isValidGoogleReviewUrl(googleReviewUrl)) {
      return res.render('theme-settings', {
        merchant,
        theme: { ...existingTheme, layoutId: safeLayoutId, logoUrl, displayName, location, primaryColor, accentColor, headerText, footerText, googleReviewUrl, showGoogleReview: true, showWarranty: showWarranty === 'on', showLoyalty: showLoyalty === 'on', showWalletSave: showWalletSave === 'on' },
        saved: false,
        error: 'Enter a valid Google review link (should start with https:// and be a Google URL).',
      });
    }
  }

  await prisma.receiptTheme.upsert({
    where: { merchantId: req.session.merchantId },
    update: {
      layoutId: safeLayoutId,
      logoUrl,
      displayName: displayName || null,
      location: location || null,
      primaryColor: primaryColor || '#111111',
      accentColor: accentColor || '#2563eb',
      headerText: headerText || null,
      footerText: footerText || null,
      googleReviewUrl: googleReviewUrl || null,
      showGoogleReview: showGoogleReview === 'on',
      showWarranty: showWarranty === 'on',
      showLoyalty: showLoyalty === 'on',
      showWalletSave: showWalletSave === 'on',
    },
    create: {
      merchantId: req.session.merchantId,
      layoutId: safeLayoutId,
      logoUrl,
      displayName: displayName || null,
      location: location || null,
      primaryColor: primaryColor || '#111111',
      accentColor: accentColor || '#2563eb',
      headerText: headerText || null,
      footerText: footerText || null,
      googleReviewUrl: googleReviewUrl || null,
      showGoogleReview: showGoogleReview === 'on',
      showWarranty: showWarranty === 'on',
      showLoyalty: showLoyalty === 'on',
      showWalletSave: showWalletSave === 'on',
    },
  });

  const theme = await prisma.receiptTheme.findUnique({ where: { merchantId: req.session.merchantId } });
  res.render('theme-settings', { merchant, theme, saved: true, error: null });
});

// Basic sanity check — must be a real URL and reasonably likely to be a Google link.
// Not exhaustive (Google review links can come from several valid domains/formats),
// just enough to catch empty strings, typos, or non-URLs before they reach customers.
function isValidGoogleReviewUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && /google\.com|g\.page|goo\.gl/.test(parsed.hostname);
  } catch {
    return false;
  }
}

module.exports = router;
