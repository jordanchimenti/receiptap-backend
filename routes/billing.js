// routes/billing.js
// ReceipTap's own subscription billing (merchant pays ReceipTap monthly).
// Not to be confused with routes/webhooks.js, which handles POS sale events —
// this file's webhook is Stripe telling us about subscription changes.

const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const {
  stripe,
  createCheckoutSession,
  createPortalSession,
  handleWebhookEvent,
  hasAccess,
} = require('../services/stripeService');

function requireAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

// GET /dashboard/billing — shows trial/subscription status, upgrade or manage button
router.get('/dashboard/billing', requireAuth, async (req, res) => {
  const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
  res.render('billing', {
    merchant,
    access: hasAccess(merchant),
    error: req.query.error || null,
    blocked: req.query.blocked === '1',
    success: req.query.success === '1',
  });
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
