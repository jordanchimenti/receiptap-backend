// routes/theme-settings.js
// Where a merchant sets everything that drives their receipt's appearance,
// including the Google review link used by the "Rate us on Google" card.

const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function requireAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

router.get('/dashboard/settings/receipt', requireAuth, async (req, res) => {
  const theme = await prisma.receiptTheme.findUnique({
    where: { merchantId: req.session.merchantId },
  });

  res.render('theme-settings', {
    theme: theme || {
      layoutId: 'classic',
      logoUrl: '',
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

  const previewTheme = {
    ...(savedTheme || { primaryColor: '#111111', accentColor: '#2563eb' }),
    layoutId: req.params.layoutId,
    primaryColor: req.query.primaryColor || (savedTheme && savedTheme.primaryColor) || '#111111',
    accentColor: req.query.accentColor || (savedTheme && savedTheme.accentColor) || '#2563eb',
    headerText: req.query.headerText || (savedTheme && savedTheme.headerText) || 'Thanks for stopping by!',
    logoUrl: req.query.logoUrl || (savedTheme && savedTheme.logoUrl) || null,
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
  });
});

router.post('/dashboard/settings/receipt', requireAuth, async (req, res) => {
  const {
    layoutId, logoUrl, primaryColor, accentColor, headerText, footerText,
    googleReviewUrl, showGoogleReview, showWarranty, showLoyalty, showWalletSave,
  } = req.body;

  const safeLayoutId = ['classic', 'modern', 'minimal'].includes(layoutId) ? layoutId : 'classic';

  // If they've turned the review toggle on, require a real, well-formed URL —
  // this is the link customers will actually be sent to, so it has to work.
  if (showGoogleReview === 'on') {
    if (!googleReviewUrl || !isValidGoogleReviewUrl(googleReviewUrl)) {
      const theme = await prisma.receiptTheme.findUnique({ where: { merchantId: req.session.merchantId } });
      return res.render('theme-settings', {
        theme: { ...theme, layoutId: safeLayoutId, logoUrl, primaryColor, accentColor, headerText, footerText, googleReviewUrl, showGoogleReview: true, showWarranty: showWarranty === 'on', showLoyalty: showLoyalty === 'on', showWalletSave: showWalletSave === 'on' },
        saved: false,
        error: 'Enter a valid Google review link (should start with https:// and be a Google URL).',
      });
    }
  }

  await prisma.receiptTheme.upsert({
    where: { merchantId: req.session.merchantId },
    update: {
      layoutId: safeLayoutId,
      logoUrl: logoUrl || null,
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
      logoUrl: logoUrl || null,
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
  res.render('theme-settings', { theme, saved: true, error: null });
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
