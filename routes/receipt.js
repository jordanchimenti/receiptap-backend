// routes/receipt.js
// The final link in the chain: tap -> /r/:puckId -> /receipt/:transactionId -> this route

const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.get('/receipt/:transactionId', async (req, res) => {
  const transaction = await prisma.transaction.findUnique({
    where: { id: req.params.transactionId },
  });

  if (!transaction) {
    return res.status(404).send('Receipt not found');
  }

  // Theme is per-merchant, not per-transaction — same theme reused for every receipt
  const theme = await prisma.receiptTheme.findUnique({
    where: { merchantId: transaction.merchantId },
  });

  const merchant = await prisma.merchant.findUnique({
    where: { id: transaction.merchantId },
  });

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
    showLoyalty: false,
    showWalletSave: true,
  };

  res.render('receipt', {
    merchant,
    theme: safeTheme,
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
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
