// routes/receipt.js
// The final link in the chain: tap -> /r/:puckId -> /receipt/:transactionId -> this route

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

router.get('/receipt/:transactionId', async (req, res) => {
  const transaction = await prisma.transaction.findUnique({
    where: { id: req.params.transactionId },
  });

  if (!transaction) {
    return res.status(404).send('Receipt not found');
  }

  // Everything below only depends on transaction.merchantId (already known)
  // or the customer's session -- nothing here depends on anything else in
  // this batch, so run them as one parallel round trip instead of four
  // sequential ones. This is the page a customer waits on right after
  // paying, so shaving off that latency matters more here than almost
  // anywhere else in the app.
  const [theme, merchant, loyaltyProgram, loyaltyCard] = await Promise.all([
    prisma.receiptTheme.findUnique({ where: { merchantId: transaction.merchantId } }),
    prisma.merchant.findUnique({ where: { id: transaction.merchantId } }),
    prisma.loyaltyProgram.findUnique({ where: { merchantId: transaction.merchantId } }),
    // Only look up a card if we actually recognize this browser as a customer --
    // an anonymous visitor gets the "join" card, not someone else's progress.
    req.session.customerId
      ? prisma.loyaltyCard.findUnique({
          where: { merchantId_customerId: { merchantId: transaction.merchantId, customerId: req.session.customerId } },
        })
      : null,
  ]);

  // Fall back to sane defaults if a merchant hasn't customized anything yet
  const safeTheme = theme || {
    layoutId: 'classic',
    logoUrl: null,
    primaryColor: '#111111',
    accentColor: '#2563eb',
    headerText: `Thanks for shopping at ${merchant.businessName}!`,
    footerText: null,
    showGoogleReview: false,
    showWarranty: false,
    showWalletSave: true,
  };

  res.render('receipt', {
    merchant,
    theme: safeTheme,
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    alreadySignedUp: Boolean(req.session.customerId),
    loyaltyProgram,
    loyaltyCard,
    transaction: {
      ...transaction,
      lineItems: transaction.lineItems, // already JSON from Prisma
      subtotal: (transaction.subtotal / 100).toFixed(2),
      tax: (transaction.tax / 100).toFixed(2),
      total: (transaction.total / 100).toFixed(2),
      date: transaction.createdAt.toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    },
  });
});

module.exports = router;
