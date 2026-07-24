// middleware/subscriptionGate.js
// Blocks merchant-dashboard access for merchants without a valid subscription
// (INCOMPLETE = never started trial, CANCELED = canceled or dunning exhausted).
// PAST_DUE keeps access during Stripe's retry window — the billing page shows
// a warning — because cutting service on the first failed charge is harsh
// when it's usually just an expired card.
//
// Because local status can go stale without webhooks, this middleware
// re-checks Stripe directly (at most once every 10 minutes per merchant)
// whenever the local status would block or warn. That way cancellations are
// enforced and reactivations are honored even before webhooks are set up.

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { stripe } = require('../services/stripeService');

const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const lastRefresh = new Map(); // merchantId -> timestamp

function mapStripeStatus(stripeStatus) {
  if (stripeStatus === 'trialing') return 'TRIALING';
  if (stripeStatus === 'active') return 'ACTIVE';
  if (stripeStatus === 'past_due' || stripeStatus === 'unpaid') return 'PAST_DUE';
  if (stripeStatus === 'canceled' || stripeStatus === 'incomplete_expired') return 'CANCELED';
  return 'ACTIVE';
}

async function refreshStatusFromStripe(merchant) {
  if (!stripe || !merchant.stripeSubscriptionId) return merchant;
  const last = lastRefresh.get(merchant.id) || 0;
  if (Date.now() - last < REFRESH_INTERVAL_MS) return merchant;
  lastRefresh.set(merchant.id, Date.now());

  try {
    const sub = await stripe.subscriptions.retrieve(merchant.stripeSubscriptionId);
    const status = mapStripeStatus(sub.status);
    if (status !== merchant.subscriptionStatus) {
      return prisma.merchant.update({
        where: { id: merchant.id },
        data: { subscriptionStatus: status },
      });
    }
  } catch (err) {
    console.error('[subscriptionGate] Stripe status refresh failed:', err.message);
  }
  return merchant;
}

/**
 * Use on merchant dashboard routes AFTER requireAuth. Redirects blocked
 * merchants to /dashboard/billing (which stays accessible so they can fix it).
 */
async function requireActiveSubscription(req, res, next) {
  try {
    let merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
    if (!merchant) return res.redirect('/login');

    // Refresh from Stripe when local state would block or when there's a
    // subscription that might have changed state
    if (['CANCELED', 'PAST_DUE', 'INCOMPLETE'].includes(merchant.subscriptionStatus)) {
      merchant = await refreshStatusFromStripe(merchant);
    }

    if (['INCOMPLETE', 'CANCELED'].includes(merchant.subscriptionStatus)) {
      return res.redirect('/dashboard/billing?blocked=1');
    }

    // PAST_DUE: allow through; billing page shows the warning
    res.locals.subscriptionStatus = merchant.subscriptionStatus;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireActiveSubscription };
