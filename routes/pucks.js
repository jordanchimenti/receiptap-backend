// routes/pucks.js
// Mount this in your Express app, e.g. app.use(pucksRouter)

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

// Adjust this to however your app checks auth — placeholder shown here
function requireAuth(req, res, next) {
  if (!req.session?.merchantId) {
    return res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

// ---------------------------------------------------------------------------
// GET /r/:puckId
// This is the URL permanently encoded (and locked) on every NFC chip.
// Same URL forever — what it does depends on the puck's current status.
// NFC only — there is no QR code path.
// ---------------------------------------------------------------------------
router.get('/r/:puckId', async (req, res) => {
  const puck = await prisma.puck.findUnique({ where: { id: req.params.puckId } });

  if (!puck) {
    return res.redirect('/not-found');
  }

  if (puck.status === 'UNCLAIMED') {
    return res.redirect(`/claim/${puck.id}`);
  }

  const hasLiveTransaction =
    puck.currentTransactionId &&
    puck.transactionExpiresAt &&
    puck.transactionExpiresAt > new Date();

  if (puck.status === 'CLAIMED' && !hasLiveTransaction) {
    return res.redirect(`/merchant/${puck.merchantId}`);
  }

  // Claimed + a transaction was just rung in, still within the claim window
  return res.redirect(`/receipt/${puck.currentTransactionId}`);
});

// ---------------------------------------------------------------------------
// GET /not-found
// Reached from /r/:puckId when the tapped ID doesn't match any puck at all.
// ---------------------------------------------------------------------------
router.get('/not-found', (req, res) => {
  res.status(404).render('puck-not-found');
});

// ---------------------------------------------------------------------------
// GET /merchant/:id
// Reached from /r/:puckId when the puck is claimed but no sale is currently
// live at that register (nothing rung in recently, or the 3-minute window
// on the last sale already expired).
// ---------------------------------------------------------------------------
router.get('/merchant/:id', async (req, res) => {
  const merchant = await prisma.merchant.findUnique({ where: { id: req.params.id } });
  if (!merchant) return res.redirect('/not-found');

  const theme = await prisma.receiptTheme.findUnique({ where: { merchantId: merchant.id } });

  res.render('no-live-receipt', {
    businessName: theme?.displayName || merchant.businessName,
    logoUrl: theme?.logoUrl || null,
  });
});

// ---------------------------------------------------------------------------
// GET /claim/:puckId
// Loaded by tapping an unclaimed puck. `?code=` is accepted to pre-fill the
// activation code field but nothing currently links here with it set (no QR
// path exists) — the merchant types the 6-character code from the insert
// card by hand.
// ---------------------------------------------------------------------------
router.get('/claim/:puckId', requireAuth, async (req, res) => {
  const puck = await prisma.puck.findUnique({ where: { id: req.params.puckId } });

  if (!puck) return res.status(404).send('Puck not found');
  if (puck.status !== 'UNCLAIMED') {
    return res.status(400).send('This puck has already been activated.');
  }

  const prefilledCode = req.query.code || '';

  // Render your actual claim page here — passing puckId + prefilledCode to the template
  res.render('claim', { puckId: puck.id, prefilledCode });
});

// ---------------------------------------------------------------------------
// POST /claim/:puckId
// Submits the claim code and, if valid, links the puck to the logged-in merchant
// ---------------------------------------------------------------------------
router.post('/claim/:puckId', requireAuth, async (req, res) => {
  const { claimCode } = req.body;
  const puck = await prisma.puck.findUnique({ where: { id: req.params.puckId } });

  if (!puck || puck.status !== 'UNCLAIMED') {
    return res.status(400).json({ error: 'Puck not available to claim' });
  }

  if (!claimCode || puck.claimCode !== claimCode.trim().toUpperCase()) {
    return res.status(400).json({ error: 'Incorrect activation code' });
  }

  const updated = await prisma.puck.update({
    where: { id: puck.id },
    data: {
      status: 'CLAIMED',
      merchantId: req.session.merchantId,
      claimedAt: new Date(),
    },
  });

  res.json({ success: true, puck: updated });
});

module.exports = router;
