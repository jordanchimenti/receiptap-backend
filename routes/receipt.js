// routes/receipt.js
// The final link in the chain: tap -> /r/:puckId -> /receipt/:transactionId -> this route

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { SHOPPER_CONSENT } = require('../config/legal');

router.get('/receipt/:transactionId', async (req, res) => {
  const transaction = await prisma.transaction.findUnique({
    where: { id: req.params.transactionId },
  });

  if (!transaction) {
    return res.status(404).send('Receipt not found');
  }

  // The merchant-copy view is for the merchant's own records only -- anyone
  // else requesting ?copy=merchant just silently gets the normal customer
  // copy instead of the flag being honored.
  const isMerchantCopy = req.query.copy === 'merchant' && req.session.merchantId === transaction.merchantId;

  // Everything below only depends on transaction.merchantId (already known)
  // or the customer's session -- nothing here depends on anything else in
  // this batch, so run them as one parallel round trip instead of four
  // sequential ones. This is the page a customer waits on right after
  // paying, so shaving off that latency matters more here than almost
  // anywhere else in the app.
  const [theme, merchant, loyaltyProgram, loyaltyCard, partnerAffiliate] = await Promise.all([
    prisma.receiptTheme.findUnique({ where: { merchantId: transaction.merchantId } }),
    prisma.merchant.findUnique({ where: { id: transaction.merchantId } }),
    // The merchant copy never shows the loyalty card, so skip both lookups.
    isMerchantCopy ? null : prisma.loyaltyProgram.findUnique({ where: { merchantId: transaction.merchantId } }),
    isMerchantCopy || !req.session.customerId
      ? null
      : prisma.loyaltyCard.findUnique({
          where: { merchantId_customerId: { merchantId: transaction.merchantId, customerId: req.session.customerId } },
        }),
    // Read-only lookup -- the affiliate row is created when the merchant
    // turns the banner on in Settings, not lazily here on a customer's load.
    isMerchantCopy ? null : prisma.affiliate.findUnique({ where: { merchantId: transaction.merchantId } }),
  ]);

  // Fall back to sane defaults if a merchant hasn't customized anything yet
  const safeTheme = theme || {
    layoutId: 'classic',
    logoUrl: null,
    primaryColor: '#111111',
    accentColor: '#2563eb',
    headerText: `Thanks for shopping at ${merchant.businessName}!`,
    footerText: null,
    location: null,
    phone: null,
    gstHstNumber: null,
    taxLabel: 'Tax',
    returnPolicy: null,
    showGoogleReview: false,
    showWarranty: false,
    showWalletSave: true,
    showPartnerProgram: false,
  };

  const partnerReferralUrl = !isMerchantCopy && safeTheme.showPartnerProgram && partnerAffiliate
    ? `${req.protocol}://${req.get('host')}/signup?ref=${partnerAffiliate.referralCode}`
    : null;

  res.render('receipt', {
    merchant,
    theme: safeTheme,
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    alreadySignedUp: Boolean(req.session.customerId),
    loyaltyProgram,
    loyaltyCard,
    partnerReferralUrl,
    isMerchantCopy,
    shopperConsentText: SHOPPER_CONSENT,
    transaction: {
      ...transaction,
      lineItems: transaction.lineItems, // already JSON from Prisma
      subtotal: (transaction.subtotal / 100).toFixed(2),
      tax: (transaction.tax / 100).toFixed(2),
      discount: (transaction.discountTotal / 100).toFixed(2),
      total: (transaction.total / 100).toFixed(2),
      date: transaction.createdAt.toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    },
  });
});

module.exports = router;
