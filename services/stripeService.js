const Stripe = require('stripe');
const prisma = require('../lib/prisma');
const { MERCHANT_AFFILIATE_RATE, REGULAR_AFFILIATE_RATE } = require('./affiliateRates');

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' })
  : null;

const TRIAL_DAYS = 30;

// The Hardware section of the Terms of Service (TERMS.version 2026-08-06.2)
// discloses this as a flat one-time charge to actually receive the included
// puck. Charged as a one-time Checkout line item alongside the recurring
// subscription price -- Stripe invoices and collects a one-time item
// immediately at checkout even when the recurring item has a trial, so this
// lands today, not deferred to when the trial ends.
const SHIPPING_FEE_CENTS = 2500; // $25.00 USD

/**
 * Creates a Stripe Checkout session for a merchant to start their subscription.
 * Card is collected upfront; Stripe runs a 30-day trial and auto-charges when
 * it ends. Reuses their existing Stripe customer if one already exists.
 *
 * The one-time $25 shipping fee is only added for a genuinely first-time
 * subscriber (subscriptionStatus !== 'CANCELED') -- a merchant restarting
 * after cancelling is never charged shipping again, permanently, by
 * founder decision (2026-08-07): whether they still have their puck isn't
 * tracked closely enough to charge correctly in both directions (Puck's
 * returnDeadlineAt/returnedAt track the return window, but nothing
 * upgrades a return window into "they definitely need a new puck shipped"
 * automatically), and this scenario has had zero real-world volume so
 * far. See docs/LEGAL_REVIEW_NOTES.md item 6 for the full reasoning.
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

  const isFirstTimeSubscriber = merchant.subscriptionStatus !== 'CANCELED';

  const lineItems = [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }];
  if (isFirstTimeSubscriber) {
    lineItems.push({
      price_data: {
        currency: 'usd',
        product_data: { name: 'ReceipTap puck — shipping (one-time)' },
        unit_amount: SHIPPING_FEE_CENTS,
      },
      quantity: 1,
    });
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: lineItems,
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
 * Fetches the real subscription price from Stripe (amount, currency,
 * billing interval) — used so the pre-checkout screen can disclose the
 * actual price instead of a hand-maintained copy of the number that goes
 * stale silently if the Stripe Price is ever changed. Returns null if
 * Stripe isn't configured or the price can't be fetched, so the caller can
 * degrade gracefully rather than crash the billing page over this.
 */
async function getSubscriptionPrice() {
  if (!stripe || !process.env.STRIPE_PRICE_ID) return null;
  try {
    const price = await stripe.prices.retrieve(process.env.STRIPE_PRICE_ID);
    return {
      amount: (price.unit_amount / 100).toFixed(2),
      currency: price.currency.toUpperCase(),
      interval: price.recurring?.interval || 'month',
    };
  } catch {
    return null;
  }
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

/** Attempts a real transfer for one commission and records the outcome.
 * Safe to call speculatively -- a Stripe error (e.g. insufficient platform
 * balance) just leaves the commission FAILED for manual follow-up rather
 * than throwing out of the webhook handler. */
async function tryPayCommission(commission, affiliate) {
  try {
    const transfer = await payAffiliateCommission(
      affiliate.stripeConnectAccountId,
      commission.amountCents,
      commission.id
    );
    await prisma.commission.update({
      where: { id: commission.id },
      data: { status: 'PAID', stripeTransferId: transfer.id, paidAt: new Date() },
    });
  } catch (err) {
    console.error(`Failed to pay affiliate commission ${commission.id}:`, err.message);
    await prisma.commission.update({ where: { id: commission.id }, data: { status: 'FAILED' } });
  }
}

/** Records the commission owed on a referred merchant's successful payment.
 * Idempotent on stripeInvoiceId -- Stripe can and does redeliver the same
 * webhook event more than once. Doesn't pay it out immediately -- commissions
 * sit PENDING and go out in a batch on the affiliate's own payout schedule
 * (see runScheduledPayouts), same as everything else that accrues. */
async function recordAffiliateCommission(invoice) {
  if (!invoice.amount_paid || invoice.amount_paid <= 0) return; // e.g. a $0 trial-start invoice

  const merchant = await prisma.merchant.findFirst({ where: { stripeCustomerId: invoice.customer } });
  if (!merchant || !merchant.referredByAffiliateId) return; // not a referred merchant

  const existing = await prisma.commission.findUnique({ where: { stripeInvoiceId: invoice.id } });
  if (existing) return;

  const affiliate = await prisma.affiliate.findUnique({
    where: { id: merchant.referredByAffiliateId },
    include: { merchant: true }, // the affiliate's OWN merchant account, if type MERCHANT
  });
  if (!affiliate) return;

  const rate = affiliate.type === 'MERCHANT' ? MERCHANT_AFFILIATE_RATE : REGULAR_AFFILIATE_RATE;

  // Merchant-affiliates only accrue new commissions while their own
  // subscription is active -- commissions already earned are unaffected,
  // this only blocks new ones from being created while lapsed.
  if (affiliate.type === 'MERCHANT' && affiliate.merchant?.subscriptionStatus !== 'ACTIVE') return;

  const amountCents = Math.round(invoice.amount_paid * (rate / 100));

  await prisma.commission.create({
    data: {
      affiliateId: affiliate.id,
      merchantId: merchant.id,
      stripeInvoiceId: invoice.id,
      amountCents,
      rate,
      status: 'PENDING',
    },
  });
}

/** Pays out every PENDING commission for an affiliate right now, outside the
 * normal schedule -- called once they finish Stripe Connect onboarding, to
 * flush anything that accrued while they had no payout account to send it
 * to. Counts as their first payout cycle, so the schedule resets from here. */
async function payPendingCommissionsForAffiliate(affiliateId) {
  const affiliate = await prisma.affiliate.findUnique({ where: { id: affiliateId } });
  if (!affiliate?.stripeConnectOnboarded || !affiliate.stripeConnectAccountId) return;

  const pending = await prisma.commission.findMany({ where: { affiliateId, status: 'PENDING' } });
  for (const commission of pending) {
    await tryPayCommission(commission, affiliate);
  }
  if (pending.length > 0) {
    await prisma.affiliate.update({ where: { id: affiliateId }, data: { lastPayoutAt: new Date() } });
  }
}

const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
const MONTHLY_MS = 30 * 24 * 60 * 60 * 1000;

/** Runs on an interval (see server.js) and pays out every onboarded
 * affiliate whose chosen cadence -- weekly or monthly -- is due, batching up
 * whatever commissions have accumulated as PENDING since their last payout.
 * An affiliate with nothing owed yet just gets skipped this round rather
 * than having their clock reset, so the next check still catches them as
 * soon as something's actually there to pay. */
async function runScheduledPayouts() {
  if (!stripe) return;

  const affiliates = await prisma.affiliate.findMany({
    where: { stripeConnectOnboarded: true, stripeConnectAccountId: { not: null } },
  });

  const now = Date.now();
  for (const affiliate of affiliates) {
    const intervalMs = affiliate.payoutFrequency === 'MONTHLY' ? MONTHLY_MS : WEEKLY_MS;
    const due = !affiliate.lastPayoutAt || now - affiliate.lastPayoutAt.getTime() >= intervalMs;
    if (!due) continue;

    const pending = await prisma.commission.findMany({ where: { affiliateId: affiliate.id, status: 'PENDING' } });
    if (pending.length === 0) continue;

    for (const commission of pending) {
      await tryPayCommission(commission, affiliate);
    }
    await prisma.affiliate.update({ where: { id: affiliate.id }, data: { lastPayoutAt: new Date() } });
  }
}

const RETURN_WINDOW_DAYS = 30; // Terms' Hardware section: 30 days from cancellation to return a puck

/**
 * Starts or clears a merchant's puck return windows depending on their new
 * subscription status. CANCELED starts a 30-day return clock (Terms'
 * Hardware section) on every puck they currently have and haven't already
 * returned. ACTIVE/TRIALING (a restart) clears any pending window, since
 * they're keeping their hardware. This only tracks the clock — the $60 USD
 * replacement fee itself is still charged by hand in Stripe if the deadline
 * passes with no return; see docs/LEGAL_REVIEW_NOTES.md item 7 for why
 * that isn't automated (yet).
 */
async function syncPuckReturnWindows(merchantId, newStatus) {
  if (newStatus === 'CANCELED') {
    await prisma.puck.updateMany({
      where: { merchantId, returnDeadlineAt: null, returnedAt: null },
      data: { returnDeadlineAt: new Date(Date.now() + RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000) },
    });
  } else if (newStatus === 'ACTIVE' || newStatus === 'TRIALING') {
    await prisma.puck.updateMany({
      where: { merchantId, returnDeadlineAt: { not: null }, returnedAt: null },
      data: { returnDeadlineAt: null },
    });
  }
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
      const merchant = await prisma.merchant.findUnique({ where: { stripeCustomerId: sub.customer } });
      if (!merchant) break;
      await prisma.merchant.update({
        where: { id: merchant.id },
        data: { stripeSubscriptionId: sub.id, subscriptionStatus: status },
      });
      await syncPuckReturnWindows(merchant.id, status);
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const merchant = await prisma.merchant.findUnique({ where: { stripeCustomerId: sub.customer } });
      if (!merchant) break;
      await prisma.merchant.update({
        where: { id: merchant.id },
        data: { subscriptionStatus: 'CANCELED' },
      });
      await syncPuckReturnWindows(merchant.id, 'CANCELED');
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
    case 'invoice.payment_succeeded': {
      await recordAffiliateCommission(event.data.object);
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
  getSubscriptionPrice,
  createPortalSession,
  handleWebhookEvent,
  syncPuckReturnWindows,
  hasAccess,
  mapStripeStatus,
  TRIAL_DAYS,
  SHIPPING_FEE_CENTS,
  applyRetentionDiscount,
  cancelSubscriptionAtPeriodEnd,
  resumeSubscription,
  createAffiliateConnectAccount,
  createAffiliateOnboardingLink,
  getAffiliateConnectStatus,
  payAffiliateCommission,
  payPendingCommissionsForAffiliate,
  runScheduledPayouts,
};
