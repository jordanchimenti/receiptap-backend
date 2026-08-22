// routes/receipt.js
// The final link in the chain: tap -> /r/:puckId -> /receipt/:transactionId -> this route

const express = require('express');
const { toSvg: barcodeSvg } = require('../lib/code128');
const { resolveBarcodeValue } = require('../lib/barcodeValue');
const router = express.Router();
const prisma = require('../lib/prisma');
const { SHOPPER_CONSENT } = require('../config/legal');
const { getBaseUrl } = require('../lib/baseUrl');
const { claimReceiptForShopper } = require('../services/claimReceipt');

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

  // Tapping the puck IS the save, for anyone already signed in. The modal on
  // this page has always promised "every receipt you tap for saves itself",
  // but until now nothing linked the receipt unless they also pressed a
  // button -- so a shopper who tapped and pocketed their phone got nothing.
  //
  // Skipped for the merchant copy (a merchant reading their own record isn't
  // a shopper saving it), and claimReceiptForShopper refuses a receipt that
  // already belongs to someone else. Best-effort: a failure here must never
  // stop the receipt rendering, which is the thing the customer is waiting for.
  if (!isMerchantCopy && req.session.customerId) {
    try {
      // Opt-out, not opt-in: on by default because it's what the modal
      // promises, but a shopper who turned it off in Settings gets the old
      // behaviour -- nothing saves until they press Save.
      const shopper = await prisma.customer.findUnique({
        where: { id: req.session.customerId },
        select: { autoSaveOnTap: true },
      });
      if (shopper?.autoSaveOnTap) {
        await claimReceiptForShopper(transaction.id, req.session.customerId);
      }
    } catch (err) {
      console.error('[receipt] auto-claim on view failed (receipt still shown):', err.message);
    }
  }

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
    ? `${getBaseUrl(req)}/signup?ref=${partnerAffiliate.referralCode}`
    : null;

  // Scannable Code 128 of whichever identifier the merchant picked, so staff
  // can pull the sale up from the customer's phone with the same gun they use
  // on printed receipts. barcodeMarkup stays null when this sale has no such
  // identifier -- the template shows an empty state instead of encoding a
  // wrong or made-up value.
  let barcodeValue = null;
  let barcodeMarkup = null;
  if (safeTheme.showBarcode) {
    barcodeValue = resolveBarcodeValue(safeTheme, transaction);
    barcodeMarkup = barcodeValue ? barcodeSvg(barcodeValue) : null;
  }

  res.render('receipt', {
    merchant,
    theme: safeTheme,
    barcodeValue,
    barcodeMarkup,
    // Only Square exposes a card fingerprint, and only card sales carry one.
    // Drives whether the cross-merchant consent box is offered at all.
    canRecogniseCard: Boolean(transaction.cardFingerprintHash),
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
