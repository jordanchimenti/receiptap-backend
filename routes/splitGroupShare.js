// routes/splitGroupShare.js
// Public, unauthenticated access to one Split the Bill group -- the page a
// host's "Share link" opens (POST-free: the link is generated lazily by
// GET /account/receipts/scanned/:id/group in routes/customer-account.js, see
// getOrCreateActiveGroupShareLink there). No auth middleware here, on
// purpose, same reasoning as routes/receiptShare.js: the token itself is the
// credential, and this is exactly how a guest who has never made a
// ReceipTap account is meant to reach this page at all.
//
// Fully read-only from ReceipTap's side: a guest can only look at the
// group's still-unclaimed items and see how to pay the host. Nothing here
// writes to the database -- picking items and a payment method is scratch
// state in the guest's own browser tab, never sent back to the server. The
// host is always the one who records that money actually arrived (Record a
// cash payment), matching the "Pay Your Way" copy on this very page.

const express = require('express');
const path = require('path');
const router = express.Router();
const prisma = require('../lib/prisma');
const fileStorage = require('../lib/fileStorage');
const { isShareLinkActive } = require('../lib/receiptShareLink');
const { createSplitPaymentIntent } = require('../services/stripeService');

router.get('/split/:token', async (req, res) => {
  const link = await prisma.splitGroupShareLink.findUnique({
    where: { token: req.params.token },
    include: {
      group: {
        include: {
          scannedReceipt: true,
          customer: {
            select: {
              name: true, email: true, paypalMeHandle: true, venmoHandle: true,
              cashAppHandle: true, interacContact: true,
              stripeConnectAccountId: true, stripeConnectOnboarded: true,
            },
          },
        },
      },
    },
  });

  if (!link) return res.status(404).end();
  if (!isShareLinkActive(link, new Date())) {
    return res.render('shared-receipt-expired');
  }

  const { group } = link;
  const receipt = group.scannedReceipt;
  const items = Array.isArray(group.items) ? group.items : [];
  const unclaimedItems = items.filter((it) => !it.paid);

  // Same "back out the tax from the unclaimed total" math as
  // computeGroupFinancials in routes/customer-account.js: the receipt's
  // total already excludes the host's own hostShareCents share (subtotal AND
  // its slice of tax), so what's left over, minus the unclaimed items'
  // raw subtotal, is exactly the unclaimed portion's share of tax.
  const totalToCollectDollars = Math.max(0, receipt.total - group.hostShareCents) / 100;
  const unclaimedSubtotalDollars = unclaimedItems.reduce((sum, it) => sum + (Number(it.amount) || 0), 0);
  const unclaimedTaxDollars = Math.max(0, totalToCollectDollars - unclaimedSubtotalDollars);

  res.render('split-group-shared', {
    receipt,
    group,
    token: req.params.token,
    hostName: group.customer.name || group.customer.email,
    paypalMeHandle: group.customer.paypalMeHandle,
    venmoHandle: group.customer.venmoHandle,
    cashAppHandle: group.customer.cashAppHandle,
    interacContact: group.customer.interacContact,
    cardPaymentsEnabled: Boolean(group.customer.stripeConnectOnboarded && group.customer.stripeConnectAccountId),
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
    unclaimedItems,
    unclaimedSubtotalDollars,
    unclaimedTaxDollars,
    money: (cents) => (cents / 100).toFixed(2),
  });
});

// Creates the real PaymentIntent a guest's card/Apple Pay/Google Pay payment
// confirms against. The amount is NEVER trusted from the client -- it's
// always recomputed here from the group's own item snapshot, same rule the
// host's manual cash-payment route follows. Returns just enough JSON for
// Stripe.js to mount the Payment Element and confirm the payment; recording
// the payment itself happens later, server-side, from the
// payment_intent.succeeded webhook (services/stripeService.js) -- never from
// this response, since a guest's browser finishing this request proves
// nothing about whether they actually paid.
router.post('/split/:token/pay-intent', async (req, res) => {
  const link = await prisma.splitGroupShareLink.findUnique({
    where: { token: req.params.token },
    include: {
      group: {
        include: {
          scannedReceipt: { select: { total: true, currency: true } },
          customer: { select: { stripeConnectAccountId: true, stripeConnectOnboarded: true } },
        },
      },
    },
  });

  if (!link || !isShareLinkActive(link, new Date())) {
    return res.status(404).json({ error: 'This link is no longer active.' });
  }

  const { group } = link;
  const { customer } = group;
  if (!customer.stripeConnectOnboarded || !customer.stripeConnectAccountId) {
    return res.status(400).json({ error: 'Card payments are not set up for this receipt.' });
  }

  // The client sends real JSON (see the fetch call in
  // views/split-group-shared.ejs), so express.json() has already parsed this
  // into an actual array -- no JSON.parse needed here.
  const selectedDescriptions = Array.isArray(req.body.itemDescriptions)
    ? req.body.itemDescriptions.filter((d) => typeof d === 'string')
    : [];

  const items = Array.isArray(group.items) ? group.items : [];
  const unclaimedItems = items.filter((it) => !it.paid);
  const selectedSet = new Set(selectedDescriptions);
  const selectedItems = unclaimedItems.filter((it) => selectedSet.has(it.description));
  if (!selectedItems.length) {
    return res.status(400).json({ error: 'Select at least one item first.' });
  }

  // Same proportional-tax math as the page itself (and computeGroupFinancials
  // in routes/customer-account.js) -- computed fresh here rather than trusted
  // from the client, so the amount actually charged can never be manipulated.
  const totalToCollect = Math.max(0, group.scannedReceipt.total - group.hostShareCents) / 100;
  const unclaimedSubtotal = unclaimedItems.reduce((sum, it) => sum + (Number(it.amount) || 0), 0);
  const unclaimedTax = Math.max(0, totalToCollect - unclaimedSubtotal);
  const selectedSubtotal = selectedItems.reduce((sum, it) => sum + (Number(it.amount) || 0), 0);
  const share = unclaimedSubtotal > 0 ? selectedSubtotal / unclaimedSubtotal : 0;
  const selectedTax = unclaimedTax * share;
  const amountCents = Math.round((selectedSubtotal + selectedTax) * 100);

  if (amountCents <= 0) {
    return res.status(400).json({ error: 'Nothing to charge.' });
  }

  try {
    const intent = await createSplitPaymentIntent({
      amountCents,
      currency: group.scannedReceipt.currency || 'CAD',
      destinationAccountId: customer.stripeConnectAccountId,
      metadata: {
        splitGroupId: group.id,
        itemDescriptions: JSON.stringify(selectedDescriptions),
      },
    });
    res.json({ clientSecret: intent.client_secret, amountCents });
  } catch (err) {
    console.error('[splitGroupShare] creating PaymentIntent failed:', err.message);
    res.status(500).json({ error: "Couldn't start payment — please try again." });
  }
});

// Re-validates independently of the HTML route above, same reasoning as
// routes/receiptShare.js's image route.
router.get('/split/:token/image', async (req, res) => {
  const link = await prisma.splitGroupShareLink.findUnique({
    where: { token: req.params.token },
    select: {
      expiresAt: true,
      revokedAt: true,
      group: { select: { scannedReceipt: { select: { imageUrl: true } } } },
    },
  });

  if (!link || !isShareLinkActive(link, new Date())) {
    return res.status(404).end();
  }

  let stream;
  try {
    stream = await fileStorage.getPrivate(link.group.scannedReceipt.imageUrl);
  } catch (err) {
    console.error('[splitGroupShare] streaming shared image failed:', err.message);
    return res.status(404).end();
  }

  res.set('Cache-Control', 'private, no-store');
  res.set(
    'Content-Type',
    fileStorage.SCAN_EXT_MIME[path.extname(link.group.scannedReceipt.imageUrl).toLowerCase()] || 'application/octet-stream'
  );
  stream.on('error', (err) => {
    console.error('[splitGroupShare] shared image stream error:', err.message);
    if (!res.headersSent) res.status(404).end();
  });
  stream.pipe(res);
});

module.exports = router;
