// routes/pucks.js
// Mount this in your Express app, e.g. app.use(pucksRouter)

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { findPairableSale, bindPuckToSale, isAwaiting } = require('../lib/pairPuck');

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

  // The MERCHANT tapping their own unlinked puck is not a customer looking for
  // a receipt -- it is someone standing at the till trying to set it up. Send
  // them to pairing instead of the "no live receipt" page, which is a dead end
  // for them. A customer tapping the same puck is unaffected: this only fires
  // when the tapper is signed in as the merchant who owns it.
  const isOwner = req.session?.merchantId === puck.merchantId;
  const isLinked = Boolean(puck.posLocationId || puck.posDeviceId);
  if (puck.status === 'CLAIMED' && !hasLiveTransaction && isOwner && !isLinked) {
    return res.redirect(`/pair/${puck.id}`);
  }

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

// ---------------------------------------------------------------------------
// Tap to pair. Reached by a merchant tapping their own puck before it has been
// linked to a register -- see lib/pairPuck.js for why this exists at all.
// ---------------------------------------------------------------------------
router.get('/pair/:puckId', requireAuth, async (req, res) => {
  const puck = await prisma.puck.findUnique({ where: { id: req.params.puckId } });
  if (!puck || puck.merchantId !== req.session.merchantId) {
    return res.redirect('/account/business/pucks');
  }

  const sale = await findPairableSale(prisma, req.session.merchantId);
  res.render('puck-pair', {
    puck,
    sale: sale
      ? {
          id: sale.id,
          total: (sale.total / 100).toFixed(2),
          locationId: sale.posLocationId,
          deviceId: sale.posDeviceId,
          when: sale.createdAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        }
      : null,
    waiting: isAwaiting(puck),
    alreadyLinked: Boolean(puck.posLocationId || puck.posDeviceId),
    error: req.query.error || null,
  });
});

// Confirming the register the tapped puck belongs to.
router.post('/pair/:puckId', requireAuth, async (req, res) => {
  const puck = await prisma.puck.findUnique({ where: { id: req.params.puckId } });
  if (!puck || puck.merchantId !== req.session.merchantId) {
    return res.redirect('/account/business/pucks');
  }

  // "Wait for the next sale" -- the tap-first order. The puck holds a
  // timestamp and the next uncovered sale claims it (see claimAwaitingPuck).
  // Changed their mind -- back to being offered the last uncovered sale.
  if (req.body.mode === 'cancel') {
    await prisma.puck.update({ where: { id: puck.id }, data: { awaitingSaleAssignment: null } });
    return res.redirect(`/pair/${puck.id}`);
  }

  if (req.body.mode === 'wait') {
    await prisma.puck.update({
      where: { id: puck.id },
      data: { awaitingSaleAssignment: new Date() },
    });
    return res.redirect(`/pair/${puck.id}`);
  }

  // Re-read rather than trusting a posted location: the page the merchant is
  // looking at may be a minute old, and a sale that has since been covered by
  // another puck must not be pairable any more.
  const sale = await findPairableSale(prisma, req.session.merchantId);
  if (!sale) {
    return res.redirect(`/pair/${puck.id}?error=` + encodeURIComponent('That sale is no longer available to pair — ring another one and tap again.'));
  }

  await bindPuckToSale(prisma, puck.id, sale);
  res.redirect('/account/business/pucks?paired=' + encodeURIComponent(puck.id));
});

module.exports = router;
