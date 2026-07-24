const Stripe = require('stripe');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
  : null;

const TRIAL_DAYS = 30;

/**
 * Creates a Stripe Checkout session for a merchant to start their subscription.
 * Card is collected upfront; Stripe runs a 30-day trial and auto-charges when
 * it ends. Reuses their existing Stripe customer if one already exists.
 */
async function createCheckoutSession(merchant, successUrl, cancelUrl) {
  if (!stripe) throw new Error('Stripe is not configured yet (missing STRIPE_SECRET_KEY).');
  let customerId = merchant.stripeCustomerId;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: merchant.email,
      name: merchant.businessName,
      metadata: { merchantId: merchant.id },
    });
    customerId = customer.id;
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { stripeCustomerId: customerId },
    });
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    subscription_data: {
      trial_period_days: TRIAL_DAYS,
    },
    // Card is required upfront even though the trial is free — this is what
    // makes the auto-charge at trial end possible.
    payment_method_collection: 'always',
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  return session.url;
}

/**
 * Creates a Stripe Customer Portal session — lets a merchant manage/cancel
 * their own subscription without you building any UI for it.
 */
async function createPortalSession(merchant, returnUrl) {
  if (!stripe) throw new Error('Stripe is not configured yet (missing STRIPE_SECRET_KEY).');
  if (!merchant.stripeCustomerId) {
    throw new Error('This merchant has no Stripe customer yet — they need to subscribe first.');
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: merchant.stripeCustomerId,
    return_url: returnUrl,
  });
  return session.url;
}

/**
 * Handles incoming Stripe webhook events. Keeps the local subscriptionStatus
 * in sync so the rest of the app never has to call Stripe directly to check
 * access — it just reads Merchant.subscriptionStatus.
 */
async function handleWebhookEvent(event) {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const status = mapStripeStatus(sub.status);
      await prisma.merchant.updateMany({
        where: { stripeCustomerId: sub.customer },
        data: { stripeSubscriptionId: sub.id, subscriptionStatus: status },
      });
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      await prisma.merchant.updateMany({
        where: { stripeCustomerId: sub.customer },
        data: { subscriptionStatus: 'CANCELED' },
      });
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      await prisma.merchant.updateMany({
        where: { stripeCustomerId: invoice.customer },
        data: { subscriptionStatus: 'PAST_DUE' },
      });
      break;
    }
    default:
      // Not every event type needs handling — safe to ignore the rest.
      break;
  }
}

function mapStripeStatus(stripeStatus) {
  if (stripeStatus === 'trialing') return 'TRIALING';
  if (stripeStatus === 'active') return 'ACTIVE';
  if (stripeStatus === 'past_due' || stripeStatus === 'unpaid') return 'PAST_DUE';
  if (stripeStatus === 'canceled' || stripeStatus === 'incomplete_expired') return 'CANCELED';
  return 'ACTIVE';
}

/** True if this merchant currently has access — an active or in-trial Stripe
 * subscription. Gate enforcement (blocking usage without one) is a separate
 * follow-up decision. */
function hasAccess(merchant) {
  if (merchant.subscriptionStatus === 'ACTIVE') return true;
  if (merchant.subscriptionStatus === 'TRIALING') return true;
  return false;
}

module.exports = { stripe, createCheckoutSession, createPortalSession, handleWebhookEvent, hasAccess, TRIAL_DAYS };
