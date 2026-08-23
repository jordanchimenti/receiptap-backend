// routes/demo.js
// A real receipt page used purely as a marketing showcase on the landing
// page (embedded in an iframe, auto-scrolled). Renders the actual
// receipt.ejs template -- the exact thing a customer sees after a real tap
// -- using the founder's own real merchant/theme/affiliate/loyalty rows,
// with every optional feature turned on for the tour so a visitor scrolls
// through the partner banner, the receipt, the save buttons, the Google
// review card, the loyalty punch card, and the social links in one pass.
const express = require('express');
const { applyComplianceFloor } = require('../lib/receiptComplianceFloor');
const router = express.Router();
const prisma = require('../lib/prisma');
const { SHOPPER_CONSENT } = require('../config/legal');
const { getBaseUrl } = require('../lib/baseUrl');

router.get('/demo/receipt', async (req, res) => {
  const merchant = await prisma.merchant.findUnique({ where: { email: 'jordanchimenti98@gmail.com' } });
  if (!merchant) return res.status(404).send('Demo not available');

  const [savedTheme, affiliate, loyaltyProgram] = await Promise.all([
    prisma.receiptTheme.findUnique({ where: { merchantId: merchant.id } }),
    prisma.affiliate.findUnique({ where: { merchantId: merchant.id } }),
    prisma.loyaltyProgram.findUnique({ where: { merchantId: merchant.id } }),
  ]);

  // Everything below is display-only for this tour -- it never writes to
  // the merchant's real saved theme, it just turns on every optional
  // section for the demo render. Logo and business name are intentionally
  // genericized (not the founder's real ones) so this reads as "here's what
  // yours could look like," not "here's ReceipTap's own receipt."
  const theme = {
    layoutId: 'classic',
    primaryColor: '#111111', accentColor: '#2563eb',
    location: null, phone: null, gstHstNumber: null, taxLabel: 'Tax', returnPolicy: null, headerText: null,
    footerText: null, showWarranty: false, showWalletSave: true,
    ...savedTheme,
    logoUrl: null,
    displayName: 'Your Business Name',
    showPartnerProgram: true,
    showGoogleReview: true,
    googleReviewUrl: savedTheme?.googleReviewUrl || 'https://g.page/r/example-placeholder/review',
    instagramUrl: savedTheme?.instagramUrl || '#',
    facebookUrl: savedTheme?.facebookUrl || '#',
    tiktokUrl: savedTheme?.tiktokUrl || '#',
  };

  const partnerReferralUrl = affiliate
    ? `${getBaseUrl(req)}/signup?ref=${affiliate.referralCode}`
    : null;

  res.render('receipt', {
    merchant,
    // Same floor the real thing gets, so the demo can't advertise a receipt
    // shape that would never be issued.
    theme: applyComplianceFloor(theme, { total: 1526, tax: 176 }),
    isPreview: true, // shows the "Your custom logo" placeholder box instead of a real image
    logoPlaceholderText: 'Your custom logo',
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    alreadySignedUp: false,
    loyaltyProgram: loyaltyProgram || { enabled: true, stampsRequired: 10, rewardLabel: 'Free reward' },
    // Mid-progress, not full -- a full card auto-opens a redemption modal,
    // which would hijack the scroll tour.
    loyaltyCard: { id: 'demo', stamps: 3 },
    partnerReferralUrl,
    isMerchantCopy: false,
    shopperConsentText: SHOPPER_CONSENT,
    transaction: {
      id: 'demo', orderNumber: 'demo',
      lineItems: [
        { name: 'Iced Coffee', quantity: 1, unitPrice: 550, total: 550 },
        { name: 'Blueberry Muffin', quantity: 1, unitPrice: 425, total: 425 },
      ],
      subtotal: '9.75', tax: '1.27', discount: '0.00', total: '11.02',
      paymentMethod: 'Visa ••••4242',
      date: new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
    },
  });
});

module.exports = router;
