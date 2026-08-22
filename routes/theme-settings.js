// routes/theme-settings.js
// Where a merchant sets everything that drives their receipt's appearance,
// including the Google review link used by the "Rate us on Google" card,
// and their loyalty punch-card offer.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const QRCode = require('qrcode');
const { toSvg: barcodeSvg } = require('../lib/code128');
const { resolveBarcodeValue, normalizeBarcodeValue } = require('../lib/barcodeValue');
const prisma = require('../lib/prisma');
const { ensureMerchantAffiliate } = require('./affiliates');
const { MERCHANT_AFFILIATE_RATE } = require('../services/affiliateRates');
const { TAX_LABEL_GROUPS, TAX_LABEL_OPTIONS, CUSTOM_TAX_LABEL, isCustomTaxLabel, resolveTaxLabel } = require('../lib/taxLabels');
const { SHOPPER_CONSENT } = require('../config/legal');
const { getBaseUrl } = require('../lib/baseUrl');

function requireAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

const DEFAULT_LOYALTY = { enabled: false, offerType: 'PERCENT', offerValue: 10, redemptionCode: 'REWARD' };

// LoyaltyProgram.offerValue is stored in cents for AMOUNT offers (consistent
// with how money is stored everywhere else) but merchants enter/see dollars.
function loyaltyForDisplay(loyalty) {
  if (!loyalty) return DEFAULT_LOYALTY;
  return {
    ...loyalty,
    offerValue: loyalty.offerType === 'AMOUNT' ? loyalty.offerValue / 100 : loyalty.offerValue,
  };
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

// Wraps multer so a bad upload doesn't hit a generic Express error page --
// stashes the message on req instead of rendering directly, since this
// middleware now runs ahead of two different routes (the real dashboard's
// and the wallet's dark reskin, routes/account-business.js) that each
// render their own template. Each route checks req.logoUploadError before
// calling saveReceiptSettings below.
function handleLogoUpload(req, res, next) {
  uploadLogo(req, res, (err) => {
    if (err) {
      req.logoUploadError =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'Logo file is too large (2MB max).'
          : 'Please upload a valid image file (PNG, JPG, WEBP, or SVG).';
    }
    next();
  });
}

// Shared by GET /dashboard/settings/receipt and GET /account/business/receipt-design
// (the wallet's dark reskin) -- see routes/account-business.js.
async function computeReceiptSettingsData(merchantId) {
  const [theme, merchant, loyalty] = await Promise.all([
    prisma.receiptTheme.findUnique({ where: { merchantId } }),
    prisma.merchant.findUnique({ where: { id: merchantId } }),
    prisma.loyaltyProgram.findUnique({ where: { merchantId } }),
  ]);

  return {
    merchant,
    taxLabelGroups: TAX_LABEL_GROUPS,
    taxLabelOptions: TAX_LABEL_OPTIONS,
    customTaxLabelValue: CUSTOM_TAX_LABEL,
    taxLabelIsCustom: isCustomTaxLabel(theme && theme.taxLabel),
    theme: theme || {
      layoutId: 'classic',
      logoUrl: '',
      displayName: '',
      location: '',
      phone: '',
      primaryColor: '#111111',
      accentColor: '#2563eb',
      headerText: '',
      footerText: '',
      gstHstNumber: '',
      taxLabel: 'Tax',
      returnPolicy: '',
      showGoogleReview: false,
      googleReviewUrl: '',
      showWarranty: false,
      showWalletSave: true,
      showPartnerProgram: false,
      showLogo: true,
      showBusinessName: true,
      showAddress: true,
      showTaxNumber: true,
      showPhone: true,
      showWebsite: true,
      showBusinessEmail: true,
      showDateTime: true,
      showReceiptNumber: true,
      showRegister: false,
      showItemQuantity: true,
      showItemUnitPrice: true,
      showItemLineTotal: true,
      itemLayout: 'compact',
      showSubtotal: true,
      showDiscounts: true,
      showTax: true,
      showTotal: true,
      totalProminent: true,
      showPaymentMethod: true,
      showCardTail: true,
      showApprovalCode: false,
      showTenderChange: true,
      showBarcode: false,
      barcodeValue: 'receiptNumber',
      barcodeCustomValue: '',
      showPromo: false,
      promoTitle: '',
      promoMessage: '',
      promoButtonLabel: '',
      promoButtonUrl: '',
      promoExpiryText: '',
      socialsHeading: '',
      customLinkLabel: '',
      customLinkUrl: '',
      offerLine: '',
      footerLegal: '',
      instagramUrl: '',
      facebookUrl: '',
      tiktokUrl: '',
      xUrl: '',
      youtubeUrl: '',
      linkedinUrl: '',
    },
    loyalty: loyaltyForDisplay(loyalty),
    merchantAffiliateRate: MERCHANT_AFFILIATE_RATE,
    saved: false,
    error: null,
  };
}

router.get('/dashboard/settings/receipt', requireAuth, async (req, res) => {
  const data = await computeReceiptSettingsData(req.session.merchantId);
  res.render('theme-settings', { ...data, resent: req.query.resent === '1' });
});

// Creates a real Transaction (sample line items, clearly not a real sale)
// and hands back the actual /receipt/:id URL a customer would land on --
// not the preview iframe below, the real page, with the merchant's real
// saved theme. Demo-tier only: a demo account has no POS connected and no
// puck, so this is its only way to ever see what its receipt looks like as
// a customer would. Restricted to demo accounts specifically so a test
// transaction never ends up mixed into a real merchant's revenue/analytics
// -- a demo account has no real transactions to get confused with in the
// first place.
router.post('/dashboard/settings/receipt/test-sale', requireAuth, async (req, res) => {
  const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
  if (!merchant?.isDemoAccount) {
    return res.status(403).json({ error: 'Test receipts are only available on the free demo tier.' });
  }
  if (!merchant.emailVerifiedAt) {
    return res.status(403).json({ error: 'Verify your email before sending a test receipt — check your inbox, or resend the link from this page.' });
  }

  const lineItems = [
    { name: 'Sample Item', quantity: 1, unitPrice: 899, total: 899 },
    { name: 'Another Item', quantity: 2, unitPrice: 450, total: 900 },
  ];
  const subtotal = lineItems.reduce((sum, li) => sum + li.total, 0);
  const tax = Math.round(subtotal * 0.13); // a round, sample tax rate -- not a real jurisdiction's rate
  const total = subtotal + tax;

  const transaction = await prisma.transaction.create({
    data: {
      id: `test_${crypto.randomBytes(8).toString('hex')}`,
      merchantId: merchant.id,
      posProvider: 'test',
      lineItems,
      subtotal,
      tax,
      discountTotal: 0,
      total,
      paymentMethod: 'Test sale — no real payment',
    },
  });

  const receiptUrl = `${getBaseUrl(req)}/receipt/${transaction.id}`;
  const qrDataUrl = await QRCode.toDataURL(receiptUrl);

  res.json({ receiptUrl, qrDataUrl });
});

// A live, isolated preview of any layout + the merchant's own colors/branding —
// rendered with sample data so they can compare before committing. Reuses the
// exact same receipt.ejs shell + layout partials real customers see, so the
// preview can never drift out of sync with the real thing.
router.get('/dashboard/settings/receipt/preview/:layoutId', requireAuth, async (req, res) => {
  const [merchant, savedTheme, savedLoyaltyProgram, existingAffiliate] = await Promise.all([
    prisma.merchant.findUnique({ where: { id: req.session.merchantId } }),
    prisma.receiptTheme.findUnique({ where: { merchantId: req.session.merchantId } }),
    prisma.loyaltyProgram.findUnique({ where: { merchantId: req.session.merchantId } }),
    prisma.affiliate.findUnique({ where: { merchantId: req.session.merchantId } }),
  ]);

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
    phone: req.query.phone || (savedTheme && savedTheme.phone) || '',
    gstHstNumber: req.query.gstHstNumber || (savedTheme && savedTheme.gstHstNumber) || '',
    taxLabel: req.query.taxLabel || (savedTheme && savedTheme.taxLabel) || 'Tax',
    returnPolicy: req.query.returnPolicy || (savedTheme && savedTheme.returnPolicy) || '',
    googleReviewUrl: req.query.googleReviewUrl || (savedTheme && savedTheme.googleReviewUrl) || '',
    showGoogleReview: bool(req.query.showGoogleReview, Boolean(savedTheme && savedTheme.showGoogleReview)),
    showWarranty: bool(req.query.showWarranty, Boolean(savedTheme && savedTheme.showWarranty)),
    showWalletSave: bool(req.query.showWalletSave, savedTheme ? Boolean(savedTheme.showWalletSave) : true),
    showPartnerProgram: bool(req.query.showPartnerProgram, Boolean(savedTheme && savedTheme.showPartnerProgram)),
    instagramUrl: req.query.instagramUrl || (savedTheme && savedTheme.instagramUrl) || '',
    facebookUrl: req.query.facebookUrl || (savedTheme && savedTheme.facebookUrl) || '',
    tiktokUrl: req.query.tiktokUrl || (savedTheme && savedTheme.tiktokUrl) || '',
    xUrl: req.query.xUrl || (savedTheme && savedTheme.xUrl) || '',
    youtubeUrl: req.query.youtubeUrl || (savedTheme && savedTheme.youtubeUrl) || '',
    linkedinUrl: req.query.linkedinUrl || (savedTheme && savedTheme.linkedinUrl) || '',
    // Block toggles -- same query-param-overrides-saved-value contract as
    // everything above, so the live preview reflects unsaved edits.
    showLogo: bool(req.query.showLogo, savedTheme ? Boolean(savedTheme.showLogo) : true),
    showBusinessName: bool(req.query.showBusinessName, savedTheme ? Boolean(savedTheme.showBusinessName) : true),
    showAddress: bool(req.query.showAddress, savedTheme ? Boolean(savedTheme.showAddress) : true),
    showTaxNumber: bool(req.query.showTaxNumber, savedTheme ? Boolean(savedTheme.showTaxNumber) : true),
    showPhone: bool(req.query.showPhone, savedTheme ? Boolean(savedTheme.showPhone) : true),
    showWebsite: bool(req.query.showWebsite, savedTheme ? Boolean(savedTheme.showWebsite) : true),
    showBusinessEmail: bool(req.query.showBusinessEmail, savedTheme ? Boolean(savedTheme.showBusinessEmail) : true),
    showDateTime: bool(req.query.showDateTime, savedTheme ? Boolean(savedTheme.showDateTime) : true),
    showReceiptNumber: bool(req.query.showReceiptNumber, savedTheme ? Boolean(savedTheme.showReceiptNumber) : true),
    showRegister: bool(req.query.showRegister, Boolean(savedTheme && savedTheme.showRegister)),
    showItemQuantity: bool(req.query.showItemQuantity, savedTheme ? Boolean(savedTheme.showItemQuantity) : true),
    showItemUnitPrice: bool(req.query.showItemUnitPrice, savedTheme ? Boolean(savedTheme.showItemUnitPrice) : true),
    showItemLineTotal: bool(req.query.showItemLineTotal, savedTheme ? Boolean(savedTheme.showItemLineTotal) : true),
    itemLayout: req.query.itemLayout || (savedTheme && savedTheme.itemLayout) || 'compact',
    showSubtotal: bool(req.query.showSubtotal, savedTheme ? Boolean(savedTheme.showSubtotal) : true),
    showDiscounts: bool(req.query.showDiscounts, savedTheme ? Boolean(savedTheme.showDiscounts) : true),
    showTax: bool(req.query.showTax, savedTheme ? Boolean(savedTheme.showTax) : true),
    showTotal: bool(req.query.showTotal, savedTheme ? Boolean(savedTheme.showTotal) : true),
    totalProminent: bool(req.query.totalProminent, savedTheme ? Boolean(savedTheme.totalProminent) : true),
    showPaymentMethod: bool(req.query.showPaymentMethod, savedTheme ? Boolean(savedTheme.showPaymentMethod) : true),
    showCardTail: bool(req.query.showCardTail, savedTheme ? Boolean(savedTheme.showCardTail) : true),
    showApprovalCode: bool(req.query.showApprovalCode, Boolean(savedTheme && savedTheme.showApprovalCode)),
    showTenderChange: bool(req.query.showTenderChange, savedTheme ? Boolean(savedTheme.showTenderChange) : true),
    showBarcode: bool(req.query.showBarcode, Boolean(savedTheme && savedTheme.showBarcode)),
    barcodeValue: req.query.barcodeValue || (savedTheme && savedTheme.barcodeValue) || 'receiptNumber',
    barcodeCustomValue: req.query.barcodeCustomValue || (savedTheme && savedTheme.barcodeCustomValue) || '',
    showPromo: bool(req.query.showPromo, Boolean(savedTheme && savedTheme.showPromo)),
    promoTitle: req.query.promoTitle || (savedTheme && savedTheme.promoTitle) || '',
    promoMessage: req.query.promoMessage || (savedTheme && savedTheme.promoMessage) || '',
    promoButtonLabel: req.query.promoButtonLabel || (savedTheme && savedTheme.promoButtonLabel) || '',
    promoButtonUrl: req.query.promoButtonUrl || (savedTheme && savedTheme.promoButtonUrl) || '',
    promoExpiryText: req.query.promoExpiryText || (savedTheme && savedTheme.promoExpiryText) || '',
    socialsHeading: req.query.socialsHeading || (savedTheme && savedTheme.socialsHeading) || '',
    customLinkLabel: req.query.customLinkLabel || (savedTheme && savedTheme.customLinkLabel) || '',
    customLinkUrl: req.query.customLinkUrl || (savedTheme && savedTheme.customLinkUrl) || '',
    offerLine: req.query.offerLine || (savedTheme && savedTheme.offerLine) || '',
    footerLegal: req.query.footerLegal || (savedTheme && savedTheme.footerLegal) || '',
  };

  // Loyalty offer value travels as dollars for AMOUNT (matching what the
  // form field shows), but the receipt template expects the same stored
  // unit (cents) real theme data uses -- convert the same way the save
  // route does, so a merchant editing this field sees an accurate preview.
  const previewOfferType = req.query.loyaltyOfferType === 'AMOUNT' || req.query.loyaltyOfferType === 'PERCENT'
    ? req.query.loyaltyOfferType
    : (savedLoyaltyProgram && savedLoyaltyProgram.offerType) || 'PERCENT';
  const rawOfferValue = req.query.loyaltyOfferValue !== undefined
    ? parseFloat(req.query.loyaltyOfferValue)
    : (savedLoyaltyProgram
        ? (savedLoyaltyProgram.offerType === 'AMOUNT' ? savedLoyaltyProgram.offerValue / 100 : savedLoyaltyProgram.offerValue)
        : 10);
  const safeRawOfferValue = Number.isFinite(rawOfferValue) && rawOfferValue > 0 ? rawOfferValue : 10;

  const previewLoyaltyProgram = {
    enabled: bool(req.query.loyaltyEnabled, Boolean(savedLoyaltyProgram && savedLoyaltyProgram.enabled)),
    offerType: previewOfferType,
    offerValue: previewOfferType === 'AMOUNT' ? Math.round(safeRawOfferValue * 100) : Math.min(100, Math.round(safeRawOfferValue)),
  };
  // A representative "in progress" card so merchants can see the actual punch
  // visual, not just the empty "Join Now" state -- only shown while enabled,
  // matching exactly how the real receipt page decides whether to render it.
  const previewLoyaltyCard = previewLoyaltyProgram.enabled
    ? { id: 'preview', punches: 2 }
    : null;

  // The merchant may not have a referral code yet (only created once they
  // actually save the toggle on) -- show a placeholder link in that case so
  // the preview still renders, without implying it's live yet.
  const previewPartnerReferralUrl = previewTheme.showPartnerProgram
    ? `${getBaseUrl(req)}/signup?ref=${existingAffiliate ? existingAffiliate.referralCode : 'PREVIEW'}`
    : null;

  // Same resolver the real receipt uses, against the sample sale above -- so
  // picking "Custom value" and leaving it blank shows the same empty state a
  // customer would get, rather than a barcode that only exists in preview.
  let previewBarcodeValue = null;
  let previewBarcodeMarkup = null;
  if (previewTheme.showBarcode) {
    previewBarcodeValue = resolveBarcodeValue(previewTheme, { id: 'preview', orderNumber: 'PREVIEW-0001' });
    previewBarcodeMarkup = previewBarcodeValue ? barcodeSvg(previewBarcodeValue) : null;
  }

  res.render('receipt', {
    merchant,
    theme: previewTheme,
    barcodeValue: previewBarcodeValue,
    barcodeMarkup: previewBarcodeMarkup,
    canRecogniseCard: false, // a preview has no real card behind it
    googleClientId: '', // no need to render a live Google button inside a preview thumbnail
    loyaltyProgram: previewLoyaltyProgram,
    loyaltyCard: previewLoyaltyCard,
    partnerReferralUrl: previewPartnerReferralUrl,
    isMerchantCopy: false,
    shopperConsentText: SHOPPER_CONSENT,
    transaction: {
      id: 'preview',
      orderNumber: 'PREVIEW-0001',
      date: 'Jul 18, 2026, 2:45 PM',
      lineItems: [
        { name: 'Sample Item', quantity: 2, unitPrice: 450, total: 900 },
        { name: 'Another Item', quantity: 1, unitPrice: 450, total: 450 },
      ],
      subtotal: '13.50',
      tax: '1.76',
      discount: '1.00',
      total: '15.26',
      paymentMethod: 'Visa ••••4242',
      posDeviceId: 'Register 2',
      cardBrand: 'Visa',
      cardLast4: '4242',
      authCode: '04X219',
      amountTenderedCents: null,
      changeDueCents: null,
    },
    // This is a layout-picker preview, not a real receipt -- the merchant's
    // real logo/name still show once set (so the preview reflects reality),
    // but before a logo is uploaded, show a "Custom Logo" placeholder box
    // instead of just leaving that space blank.
    isPreview: true,
  });
});

// Shared by POST /dashboard/settings/receipt and POST /account/business/receipt-design
// (the wallet's dark reskin) -- see routes/account-business.js. Same
// validation/sanitization, same upserts either way; only which template
// the caller renders afterward differs.
async function saveReceiptSettings(merchantId, body, file) {
  const {
    layoutId, primaryColor, accentColor, headerText, footerText, displayName, taxLabel, returnPolicy,
    googleReviewUrl, showGoogleReview, showWarranty, showWalletSave, showPartnerProgram,
    instagramUrl, facebookUrl, tiktokUrl, xUrl, youtubeUrl, linkedinUrl,
    loyaltyEnabled, loyaltyOfferType, loyaltyOfferValue, loyaltyRedemptionCode,
    itemLayout, barcodeValue,
    promoTitle, promoMessage, promoButtonLabel, promoButtonUrl, promoExpiryText,
    socialsHeading, customLinkLabel, customLinkUrl, offerLine, footerLegal,
  } = body;

  // Every block toggle on the Receipt design page. Unchecked checkboxes
  // aren't submitted at all, so `=== 'on'` is the whole test -- same
  // convention the older showGoogleReview/showWarranty flags already use.
  const blockFlags = {
    showLogo: body.showLogo === 'on',
    showBusinessName: body.showBusinessName === 'on',
    showAddress: body.showAddress === 'on',
    showTaxNumber: body.showTaxNumber === 'on',
    showPhone: body.showPhone === 'on',
    showWebsite: body.showWebsite === 'on',
    showBusinessEmail: body.showBusinessEmail === 'on',
    showDateTime: body.showDateTime === 'on',
    showReceiptNumber: body.showReceiptNumber === 'on',
    showRegister: body.showRegister === 'on',
    showItemQuantity: body.showItemQuantity === 'on',
    showItemUnitPrice: body.showItemUnitPrice === 'on',
    showItemLineTotal: body.showItemLineTotal === 'on',
    itemLayout: ['detailed', 'spacious'].includes(itemLayout) ? itemLayout : 'compact',
    showSubtotal: body.showSubtotal === 'on',
    showDiscounts: body.showDiscounts === 'on',
    showTax: body.showTax === 'on',
    showTotal: body.showTotal === 'on',
    totalProminent: body.totalProminent === 'on',
    showPaymentMethod: body.showPaymentMethod === 'on',
    showCardTail: body.showCardTail === 'on',
    showApprovalCode: body.showApprovalCode === 'on',
    showTenderChange: body.showTenderChange === 'on',
    showBarcode: body.showBarcode === 'on',
    barcodeValue: normalizeBarcodeValue(barcodeValue),
    barcodeCustomValue: body.barcodeCustomValue || null,
    showPromo: body.showPromo === 'on',
    promoTitle: promoTitle || null,
    promoMessage: promoMessage || null,
    promoButtonLabel: promoButtonLabel || null,
    promoButtonUrl: sanitizeUrl(promoButtonUrl),
    promoExpiryText: promoExpiryText || null,
    socialsHeading: socialsHeading || null,
    customLinkLabel: customLinkLabel || null,
    customLinkUrl: sanitizeUrl(customLinkUrl),
    offerLine: offerLine || null,
    footerLegal: footerLegal || null,
  };

  // Picked from a dropdown now (lib/taxLabels.js); "Custom" carries the real
  // wording in taxLabelCustom. Still falls back to "Tax" rather than printing
  // an unlabelled tax line, same as when this was a free-text field.
  const safeTaxLabel = resolveTaxLabel(taxLabel, body.taxLabelCustom);

  // phone/gstHstNumber live on ReceiptTheme but are edited from Business
  // Settings' "Business Profile" panel, NOT from Receipt design (they're
  // business facts, not design). Receipt design's form therefore doesn't
  // submit them at all -- so read them only when the key is actually
  // present, or saving Receipt design would blank out the phone number and
  // tax number Business Settings just set. Absent key = leave alone;
  // present-but-empty = the merchant really did clear it.
  const keepIfAbsent = (key, current) => (key in body ? (body[key] || null) : (current ?? null));

  // website lives on Merchant, not ReceiptTheme, but it's edited from the
  // Header block here (revealed by the "Show website" switch) rather than
  // from Business Settings -- one field, one place. Only written when the
  // form actually submitted it, so the navy dashboard's older Receipt design
  // form, which has no such input, can't blank it.
  if ('website' in body) {
    await prisma.merchant.update({
      where: { id: merchantId },
      data: { website: sanitizeUrl(body.website) },
    });
  }

  const safeInstagramUrl = sanitizeUrl(instagramUrl);
  const safeFacebookUrl = sanitizeUrl(facebookUrl);
  const safeTiktokUrl = sanitizeUrl(tiktokUrl);
  const safeXUrl = sanitizeUrl(xUrl);
  const safeYoutubeUrl = sanitizeUrl(youtubeUrl);
  const safeLinkedinUrl = sanitizeUrl(linkedinUrl);

  const safeLayoutId = ['classic', 'modern', 'minimal'].includes(layoutId) ? layoutId : 'classic';
  const safeOfferType = loyaltyOfferType === 'AMOUNT' ? 'AMOUNT' : 'PERCENT';
  const parsedOfferValue = parseFloat(loyaltyOfferValue);
  const safeOfferValueDisplay = Number.isFinite(parsedOfferValue) && parsedOfferValue > 0 ? parsedOfferValue : 10;
  const safeOfferValueStored = safeOfferType === 'AMOUNT'
    ? Math.round(safeOfferValueDisplay * 100)
    : Math.min(100, Math.round(safeOfferValueDisplay));

  const [existingTheme, merchant, existingLoyaltyProgram] = await Promise.all([
    prisma.receiptTheme.findUnique({ where: { merchantId } }),
    prisma.merchant.findUnique({ where: { id: merchantId } }),
    prisma.loyaltyProgram.findUnique({ where: { merchantId } }),
  ]);

  // An empty submission shouldn't wipe out a working code -- fall back to
  // whatever was already saved, then a sane default for a brand-new program.
  const trimmedRedemptionCode = (loyaltyRedemptionCode || '').trim();
  const safeRedemptionCode = trimmedRedemptionCode || existingLoyaltyProgram?.redemptionCode || 'REWARD';

  // Turning the banner on needs a referral code to link to -- every merchant
  // is eligible, this just creates the row the first time it's actually used.
  if (showPartnerProgram === 'on') {
    await ensureMerchantAffiliate(merchantId);
  }

  // A new upload wins; otherwise keep whatever was already saved -- a file
  // input never re-submits its old value, so leaving this alone would
  // silently wipe the logo on every save.
  let logoUrl = existingTheme ? existingTheme.logoUrl : null;
  if (file) {
    logoUrl = `/uploads/logos/${file.filename}`;
  }

  // If they've turned the review toggle on, require a real, well-formed URL —
  // this is the link customers will actually be sent to, so it has to work.
  if (showGoogleReview === 'on') {
    if (!googleReviewUrl || !isValidGoogleReviewUrl(googleReviewUrl)) {
      return {
        merchant,
        theme: { ...existingTheme, layoutId: safeLayoutId, logoUrl, displayName, location, phone, gstHstNumber, taxLabel: safeTaxLabel, returnPolicy, primaryColor, accentColor, headerText, footerText, googleReviewUrl, showGoogleReview: true, showWarranty: showWarranty === 'on', showWalletSave: showWalletSave === 'on', showPartnerProgram: showPartnerProgram === 'on', instagramUrl: safeInstagramUrl, facebookUrl: safeFacebookUrl, tiktokUrl: safeTiktokUrl, xUrl: safeXUrl, youtubeUrl: safeYoutubeUrl, linkedinUrl: safeLinkedinUrl },
        loyalty: { enabled: loyaltyEnabled === 'on', offerType: safeOfferType, offerValue: safeOfferValueDisplay, redemptionCode: safeRedemptionCode },
        merchantAffiliateRate: MERCHANT_AFFILIATE_RATE,
        saved: false,
        error: 'Enter a valid Google review link (should start with https:// and be a Google URL).',
      };
    }
  }

  await Promise.all([
    prisma.receiptTheme.upsert({
      where: { merchantId },
      update: {
        layoutId: safeLayoutId,
        logoUrl,
        displayName: displayName || null,
        phone: keepIfAbsent('phone', existingTheme && existingTheme.phone),
        primaryColor: primaryColor || '#111111',
        accentColor: accentColor || '#2563eb',
        headerText: headerText || null,
        footerText: footerText || null,
        gstHstNumber: keepIfAbsent('gstHstNumber', existingTheme && existingTheme.gstHstNumber),
        taxLabel: safeTaxLabel,
        returnPolicy: returnPolicy || null,
        googleReviewUrl: googleReviewUrl || null,
        showGoogleReview: showGoogleReview === 'on',
        showWarranty: showWarranty === 'on',
        showWalletSave: showWalletSave === 'on',
        showPartnerProgram: showPartnerProgram === 'on',
        ...blockFlags,
        instagramUrl: safeInstagramUrl,
        facebookUrl: safeFacebookUrl,
        tiktokUrl: safeTiktokUrl,
        xUrl: safeXUrl,
        youtubeUrl: safeYoutubeUrl,
        linkedinUrl: safeLinkedinUrl,
      },
      create: {
        merchantId,
        layoutId: safeLayoutId,
        logoUrl,
        displayName: displayName || null,
        phone: keepIfAbsent('phone', existingTheme && existingTheme.phone),
        primaryColor: primaryColor || '#111111',
        accentColor: accentColor || '#2563eb',
        headerText: headerText || null,
        footerText: footerText || null,
        gstHstNumber: keepIfAbsent('gstHstNumber', existingTheme && existingTheme.gstHstNumber),
        taxLabel: safeTaxLabel,
        returnPolicy: returnPolicy || null,
        googleReviewUrl: googleReviewUrl || null,
        showGoogleReview: showGoogleReview === 'on',
        showWarranty: showWarranty === 'on',
        showWalletSave: showWalletSave === 'on',
        showPartnerProgram: showPartnerProgram === 'on',
        ...blockFlags,
        instagramUrl: safeInstagramUrl,
        facebookUrl: safeFacebookUrl,
        tiktokUrl: safeTiktokUrl,
        xUrl: safeXUrl,
        youtubeUrl: safeYoutubeUrl,
        linkedinUrl: safeLinkedinUrl,
      },
    }),
    prisma.loyaltyProgram.upsert({
      where: { merchantId },
      update: { enabled: loyaltyEnabled === 'on', offerType: safeOfferType, offerValue: safeOfferValueStored, redemptionCode: safeRedemptionCode },
      create: { merchantId, enabled: loyaltyEnabled === 'on', offerType: safeOfferType, offerValue: safeOfferValueStored, redemptionCode: safeRedemptionCode },
    }),
  ]);

  const [theme, loyalty] = await Promise.all([
    prisma.receiptTheme.findUnique({ where: { merchantId } }),
    prisma.loyaltyProgram.findUnique({ where: { merchantId } }),
  ]);
  return {
    merchant,
    theme,
    loyalty: loyaltyForDisplay(loyalty),
    merchantAffiliateRate: MERCHANT_AFFILIATE_RATE,
    // Same locals computeReceiptSettingsData supplies -- this path renders the
    // page directly after a save, so omitting them would throw on the tax
    // label dropdown.
    taxLabelGroups: TAX_LABEL_GROUPS,
    taxLabelOptions: TAX_LABEL_OPTIONS,
    customTaxLabelValue: CUSTOM_TAX_LABEL,
    taxLabelIsCustom: isCustomTaxLabel(theme && theme.taxLabel),
    saved: true,
    error: null,
  };
}

router.post('/dashboard/settings/receipt', requireAuth, handleLogoUpload, async (req, res) => {
  if (req.logoUploadError) {
    const data = await computeReceiptSettingsData(req.session.merchantId);
    return res.status(400).render('theme-settings', { ...data, error: req.logoUploadError, resent: false });
  }
  const result = await saveReceiptSettings(req.session.merchantId, req.body, req.file);
  res.render('theme-settings', { ...result, resent: false });
});

// Social links render as an href straight on the receipt page -- reject
// anything that isn't a real http(s) URL (e.g. a stray "javascript:" value)
// rather than trust user input directly in an anchor tag.
function sanitizeUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

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
// Exposed for routes/account-business.js -- see the comment on each above.
module.exports.computeReceiptSettingsData = computeReceiptSettingsData;
module.exports.saveReceiptSettings = saveReceiptSettings;
module.exports.handleLogoUpload = handleLogoUpload;
