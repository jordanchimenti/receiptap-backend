const Stripe = require('stripe');
const prisma = require('../lib/prisma');

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
 * Cancellation retention offer: a merchant clicking "Cancel Subscription" is
 * shown a 50%-off-next-month offer before the cancellation goes through.
 * RETENTION50 is a real Stripe coupon (50% off, one-time) created for this.
 */
const RETENTION_COUPON_ID = 'RETENTION50';

async function applyRetentionDiscount(subscriptionId) {
  if (!stripe) throw new Error('Stripe is not configured yet (missing STRIPE_SECRET_KEY).');
  return stripe.subscriptions.update(subscriptionId, { coupon: RETENTION_COUPON_ID });
}

/** Cancels at the end of the current billing period — the merchant keeps
 * access through what they already paid for, then it stops. */
async function cancelSubscriptionAtPeriodEnd(subscriptionId) {
  if (!stripe) throw new Error('Stripe is not configured yet (missing STRIPE_SECRET_KEY).');
  return stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
}

/** Undoes a pending cancellation (merchant changed their mind before the
 * period ended). */
async function resumeSubscription(subscriptionId) {
  if (!stripe) throw new Error('Stripe is not configured yet (missing STRIPE_SECRET_KEY).');
  return stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false });
}

// --- Affiliate payouts (Stripe Connect) -------------------------------------
// Requires Stripe Connect to be enabled on the platform account (a one-time
// agreement accepted in the Stripe Dashboard) -- account creation below will
// fail with a clear Stripe error if it isn't.

/** Creates the Express account an affiliate's payouts will go to. Only
 * called once per affiliate -- the id is saved and reused after this. */
async function createAffiliateConnectAccount(affiliate) {
  if (!stripe) throw new Error('Stripe is not configured yet (missing STRIPE_SECRET_KEY).');
  return stripe.accounts.create({
    type: 'express',
    email: affiliate.email,
    business_type: 'individual',
    capabilities: { transfers: { requested: true } },
  });
}

/** A one-time-use hosted link where the affiliate enters their own bank/ID
 * details directly with Stripe -- this app never sees or stores that data. */
async function createAffiliateOnboardingLink(stripeConnectAccountId, refreshUrl, returnUrl) {
  if (!stripe) throw new Error('Stripe is not configured yet (missing STRIPE_SECRET_KEY).');
  const link = await stripe.accountLinks.create({
    account: stripeConnectAccountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });
  return link.url;
}

/** Whether Stripe has actually finished verifying this account and will let
 * money be sent to it -- onboarding can be "submitted" but still pending
 * Stripe's own review, so payoutsEnabled is the real signal to check. */
async function getAffiliateConnectStatus(stripeConnectAccountId) {
  if (!stripe) throw new Error('Stripe is not configured yet (missing STRIPE_SECRET_KEY).');
  const account = await stripe.accounts.retrieve(stripeConnectAccountId);
  return { payoutsEnabled: Boolean(account.payouts_enabled), detailsSubmitted: Boolean(account.details_submitted) };
}

/** Sends a commission amount to an already-onboarded affiliate. Called from
 * Phase 3's payment-succeeded handler, not directly by any route yet. */
async function payAffiliateCommission(stripeConnectAccountId, amountCents, commissionId) {
  if (!stripe) throw new Error('Stripe is not configured yet (missing STRIPE_SECRET_KEY).');
  return stripe.transfers.create({
    amount: amountCents,
    currency: 'usd',
    destination: stripeConnectAccountId,
    metadata: { commissionId },
  });
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

module.exports = {
  stripe,
  createCheckoutSession,
  createPortalSession,
  handleWebhookEvent,
  hasAccess,
  mapStripeStatus,
  TRIAL_DAYS,
  applyRetentionDiscount,
  cancelSubscriptionAtPeriodEnd,
  resumeSubscription,
  createAffiliateConnectAccount,
  createAffiliateOnboardingLink,
  getAffiliateConnectStatus,
  payAffiliateCommission,
};
