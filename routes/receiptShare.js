// routes/receiptShare.js
// Public, unauthenticated access to one scanned receipt's photo -- a shopper
// generates this link (POST /account/receipts/scanned/:id/share in
// routes/customer-account.js) to hand to their accountant without either of
// them needing a ReceipTap login. No auth middleware here, on purpose: the
// token itself is the credential, same as routes/receipt.js's public tapped-
// receipt page, just time-limited instead of permanent (see
// lib/receiptShareLink.js for why a scanned receipt's photo -- unlike a
// tapped receipt -- can't just be a plain public page).

const express = require('express');
const path = require('path');
const router = express.Router();
const prisma = require('../lib/prisma');
const fileStorage = require('../lib/fileStorage');
const { isShareLinkActive } = require('../lib/receiptShareLink');

// A token that matches no row at all was never a real link -- nothing more
// honest to say about it than a plain 404. A token that DID work and has
// since expired or been revoked gets the friendlier page below instead;
// that distinction is the whole point of this route.
router.get('/share/receipt/:token', async (req, res) => {
  const link = await prisma.scannedReceiptShareLink.findUnique({
    where: { token: req.params.token },
    include: { scannedReceipt: true },
  });

  if (!link) return res.status(404).end();

  if (!isShareLinkActive(link, new Date())) {
    return res.render('shared-receipt-expired');
  }

  const receipt = link.scannedReceipt;
  res.render('shared-receipt', {
    receipt,
    token: req.params.token,
    money: (cents) => (cents / 100).toFixed(2),
  });
});

// Re-validates independently of the HTML route above -- someone could still
// have this exact image URL bookmarked or cached after the link died, and
// the check must hold there too, not just on the page that links to it.
router.get('/share/receipt/:token/image', async (req, res) => {
  const link = await prisma.scannedReceiptShareLink.findUnique({
    where: { token: req.params.token },
    select: {
      expiresAt: true,
      revokedAt: true,
      scannedReceipt: { select: { imageUrl: true } },
    },
  });

  if (!link || !isShareLinkActive(link, new Date())) {
    return res.status(404).end();
  }

  let stream;
  try {
    stream = await fileStorage.getPrivate(link.scannedReceipt.imageUrl);
  } catch (err) {
    console.error('[receiptShare] streaming shared image failed:', err.message);
    return res.status(404).end();
  }

  res.set('Cache-Control', 'private, no-store');
  res.set(
    'Content-Type',
    fileStorage.SCAN_EXT_MIME[path.extname(link.scannedReceipt.imageUrl).toLowerCase()] || 'application/octet-stream'
  );
  stream.on('error', (err) => {
    console.error('[receiptShare] shared image stream error:', err.message);
    if (!res.headersSent) res.status(404).end();
  });
  stream.pipe(res);
});

module.exports = router;
