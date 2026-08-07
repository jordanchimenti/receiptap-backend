// routes/billing.js
// ReceipTap's own subscription billing (merchant pays ReceipTap monthly).
// Not to be confused with routes/webhooks.js, which handles POS sale events —
// this file's webhook is Stripe telling us about subscription changes.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const prisma = require('../lib/prisma');
const {
  stripe,
  createCheckoutSession,
  getSubscriptionPrice,
  createPortalSession,
  handleWebhookEvent,
  hasAccess,
  mapStripeStatus,
  TRIAL_DAYS,
  SHIPPING_FEE_CENTS,
  applyRetentionDiscount,
  cancelSubscriptionAtPeriodEnd,
  resumeSubscription,
} = require('../services/stripeService');

function requireAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

// Profile photo uploads -- same local-disk pattern as receipt logo uploads
// (routes/theme-settings.js). Same caveat applies: this needs to move to
// real object storage before the app is actually deployed anywhere.
const PHOTO_DIR = path.join(__dirname, '..', 'public', 'uploads', 'profile-photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });

const ALLOWED_PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const uploadProfilePhoto = multer({
  storage: multer.diskStorage({
    destination: PHOTO_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${req.session.merchantId}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_PHOTO_TYPES.includes(file.mimetype)) {
      return cb(new Error('INVALID_PHOTO_TYPE'));
    }
    cb(null, true);
  },
}).single('profilePhoto');

// Wraps multer so a bad upload redirects back with a real error instead of
// a generic Express error page.
function handlePhotoUpload(req, res, next) {
  uploadProfilePhoto(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Photo file is too large (2MB max).'
        : 'Please upload a valid image file (PNG, JPG, or WEBP).';
    res.redirect(`/dashboard/billing?error=${encodeURIComponent(message)}`);
  });
}

// GET /dashboard/billing — shows real subscription/payment/invoice data from
// Stripe, plus real usage numbers from our own DB. Every Stripe call is
// wrapped so a hiccup degrades that one section to an empty state instead of
// taking down the whole page.
router.get('/dashboard/billing', requireAuth, async (req, res) => {
  let merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });

  // Coming back from a successful Checkout — sync the subscription right now
  // instead of waiting on the /webhooks/stripe event. No webhook secret is
  // configured yet, and Stripe can't reach a local dev server anyway, so
  // without this, subscriptionStatus would never leave INCOMPLETE.
  if (req.query.success === '1' && stripe && merchant.stripeCustomerId) {
    const subs = await stripe.subscriptions.list({ customer: merchant.stripeCustomerId, limit: 1 });
    const sub = subs.data[0];
    if (sub) {
      merchant = await prisma.merchant.update({
        where: { id: merchant.id },
        data: { stripeSubscriptionId: sub.id, subscriptionStatus: mapStripeStatus(sub.status) },
      });
    }
  }

  let subscription = null;
  let paymentMethod = null;
  let invoices = [];
  let upcoming = null;
  let activeReceiptTaps = 0;

  // Fetched regardless of whether this merchant has a Stripe customer yet —
  // someone who's never subscribed still needs to see the real price before
  // they click "Start free trial," not just existing subscribers.
  const price = await getSubscriptionPrice();

  if (stripe && merchant.stripeCustomerId) {
    const [subResult, pmResult, invResult, upcomingResult, puckCount] = await Promise.all([
      merchant.stripeSubscriptionId
        ? stripe.subscriptions.retrieve(merchant.stripeSubscriptionId).catch(() => null)
        : null,
      stripe.paymentMethods.list({ customer: merchant.stripeCustomerId, type: 'card' }).catch(() => ({ data: [] })),
      stripe.invoices.list({ customer: merchant.stripeCustomerId, limit: 5 }).catch(() => ({ data: [] })),
      // Passing `subscription` explicitly matters: without it, Stripe previews
      // the customer's next invoice generically and silently ignores any
      // discount attached to the actual subscription (confirmed live —
      // omitting it returned the full $49.99 even with RETENTION50 applied).
      merchant.stripeSubscriptionId
        ? stripe.invoices.createPreview({ customer: merchant.stripeCustomerId, subscription: merchant.stripeSubscriptionId }).catch(() => null)
        : null,
      prisma.puck.count({
        where: { merchantId: merchant.id, OR: [{ posLocationId: { not: null } }, { posDeviceId: { not: null } }] },
      }),
    ]);
    subscription = subResult;
    paymentMethod = pmResult.data[0] || null; // first card on file -- no "default" is set on this account
    invoices = invResult.data;
    upcoming = upcomingResult;
    activeReceiptTaps = puckCount;
  }

  // The exact date a first charge would land if they start a trial today —
  // shown on the "Not started"/"Restart subscription" screen before the
  // card is ever collected, not just computed after a subscription exists.
  const trialFirstChargeDate = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-US', { dateStyle: 'medium' });

  res.render('billing', {
    merchant,
    access: hasAccess(merchant),
    price,
    trialDays: TRIAL_DAYS,
    trialFirstChargeDate,
    shippingFee: (SHIPPING_FEE_CENTS / 100).toFixed(2),
    // Restarting after a cancellation doesn't charge shipping again — see
    // the isFirstTimeSubscriber comment on createCheckoutSession() in
    // services/stripeService.js for why that's deliberate, not an oversight.
    chargesShipping: merchant.subscriptionStatus !== 'CANCELED',
    error: req.query.error || null,
    blocked: req.query.blocked === '1',
    success: req.query.success === '1',
    discountApplied: req.query.discount === '1',
    justCanceled: req.query.canceled === '1' && Boolean(subscription?.cancel_at_period_end),
    justResumed: req.query.resumed === '1',
    subscription,
    paymentMethod,
    invoices: invoices.map((inv) => ({
      id: inv.number || inv.id,
      date: new Date(inv.created * 1000).toLocaleDateString('en-US', { dateStyle: 'medium' }),
      amount: (inv.total / 100).toFixed(2),
      status: inv.status.charAt(0).toUpperCase() + inv.status.slice(1),
      pdfUrl: inv.invoice_pdf,
    })),
    upcoming: upcoming
      ? {
          total: (upcoming.total / 100).toFixed(2),
          subtotal: (upcoming.subtotal / 100).toFixed(2),
          discountAmount: upcoming.total_discount_amounts.length
            ? (upcoming.total_discount_amounts.reduce((sum, d) => sum + d.amount, 0) / 100).toFixed(2)
            : null,
          date: subscription
            ? new Date((subscription.trial_end || subscription.current_period_end) * 1000).toLocaleDateString('en-US', { dateStyle: 'medium' })
            : null,
          lines: upcoming.lines.data.map((l) => ({ description: l.description, amount: (l.amount / 100).toFixed(2) })),
        }
      : null,
    activeReceiptTaps,
    nextBillingDate:
      subscription && (subscription.trial_end || subscription.current_period_end)
        ? new Date((subscription.trial_end || subscription.current_period_end) * 1000).toLocaleDateString('en-US', { dateStyle: 'medium' })
        : null,
    cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
  });
});

// POST /dashboard/billing/account — lets an existing merchant set/update their
// own name and profile photo (distinct from the business name/logo), used
// for the dashboard greeting and the top-right avatar
router.post('/dashboard/billing/account', requireAuth, handlePhotoUpload, async (req, res) => {
  const { ownerName } = req.body;
  const data = { ownerName: ownerName || null };
  if (req.file) {
    data.profilePhotoUrl = `/uploads/profile-photos/${req.file.filename}`;
  }
  await prisma.merchant.update({
    where: { id: req.session.merchantId },
    data,
  });
  res.redirect('/dashboard/billing');
});

// POST /dashboard/billing/checkout — starts a Stripe Checkout session, redirects there
router.post('/dashboard/billing/checkout', requireAuth, async (req, res) => {
  try {
    const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const url = await createCheckoutSession(
      merchant,
      `${baseUrl}/dashboard/billing?success=1`,
      `${baseUrl}/dashboard/billing?canceled=1`
    );
    res.redirect(url);
  } catch (err) {
    res.redirect(`/dashboard/billing?error=${encodeURIComponent(err.message)}`);
  }
});

// POST /dashboard/billing/retention-discount — merchant accepted the "wait,
// don't go" offer instead of canceling: 50% off their next invoice.
router.post('/dashboard/billing/retention-discount', requireAuth, async (req, res) => {
  try {
    const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
    if (!merchant.stripeSubscriptionId) throw new Error('No active subscription found.');
    await applyRetentionDiscount(merchant.stripeSubscriptionId);
    res.redirect('/dashboard/billing?discount=1');
  } catch (err) {
    res.redirect(`/dashboard/billing?error=${encodeURIComponent(err.message)}`);
  }
});

// POST /dashboard/billing/cancel — merchant declined the offer and confirmed
// cancellation. Takes effect at the end of the period they already paid for.
router.post('/dashboard/billing/cancel', requireAuth, async (req, res) => {
  try {
    const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
    if (!merchant.stripeSubscriptionId) throw new Error('No active subscription found.');
    await cancelSubscriptionAtPeriodEnd(merchant.stripeSubscriptionId);
    res.redirect('/dashboard/billing?canceled=1');
  } catch (err) {
    res.redirect(`/dashboard/billing?error=${encodeURIComponent(err.message)}`);
  }
});

// POST /dashboard/billing/resume — undoes a pending end-of-period cancellation.
router.post('/dashboard/billing/resume', requireAuth, async (req, res) => {
  try {
    const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
    if (!merchant.stripeSubscriptionId) throw new Error('No active subscription found.');
    await resumeSubscription(merchant.stripeSubscriptionId);
    res.redirect('/dashboard/billing?resumed=1');
  } catch (err) {
    res.redirect(`/dashboard/billing?error=${encodeURIComponent(err.message)}`);
  }
});

// POST /dashboard/billing/portal — sends an existing subscriber to Stripe's
// self-serve portal to update card details, change plan, or cancel
router.post('/dashboard/billing/portal', requireAuth, async (req, res) => {
  try {
    const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const url = await createPortalSession(merchant, `${baseUrl}/dashboard/billing`);
    res.redirect(url);
  } catch (err) {
    res.redirect(`/dashboard/billing?error=${encodeURIComponent(err.message)}`);
  }
});

// POST /webhooks/stripe — Stripe calls this on every subscription event.
// Mounted with a raw body parser in server.js (required for signature verification).
router.post('/webhooks/stripe', async (req, res) => {
  const signature = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    await handleWebhookEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error('Error handling Stripe webhook event:', err);
    res.status(500).json({ error: 'Internal error handling webhook' });
  }
});

module.exports = router;
