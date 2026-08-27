// services/merchantNotificationService.js
// Everything a merchant gets told about, in one place -- the business-side
// equivalent of services/notificationService.js (customer-facing), same
// philosophy: the database row is the record of record, written first and
// always. Most types are in-app only; billing problems and tree-planted
// thank-yous deliberately also go by email -- see sendBillingProblemEmailSafely
// and sendTreePlantedEmailSafely below for why those two are different.

const prisma = require('../lib/prisma');
const { sendBillingProblemEmail, sendTreePlantedEmail } = require('./emailService');
const { PUBLIC_IMPACT_URL } = require('./goodApiService');

async function create({ merchantId, type, title, body, linkUrl }) {
  return prisma.merchantNotification.create({
    data: { merchantId, type, title, body, linkUrl },
  });
}

// Fired alongside the existing customer-facing notifyLoyaltyCardFull
// (routes/loyalty.js's notifyIfJustFilled) -- the customer learns their card
// is full, the merchant learns they now owe someone a reward.
async function notifyMerchantLoyaltyCardFilled({ merchantId, customerId, program }) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) return null;

  const customerLabel = customer.name || customer.email;
  return create({
    merchantId,
    type: 'LOYALTY_CARD_FILLED',
    title: 'A stamp card is ready to redeem',
    body: `${customerLabel} has earned "${program.rewardLabel}" -- redeem it on their next visit.`,
    linkUrl: '/account/business/loyalty',
  });
}

// Fired on a subscription status TRANSITION to PAST_DUE or CANCELED (see
// services/stripeService.js's handleWebhookEvent) -- not on every webhook
// event, only when the status actually changes to one of these, so a
// merchant isn't renotified on every unrelated Stripe event while already
// past due. In-app AND email: see sendBillingProblemEmail's own comment for
// why this one doesn't stay in-app-only like the others.
async function notifyBillingProblem({ merchantId, status }) {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) return null;

  const isCanceled = status === 'CANCELED';
  const notification = await create({
    merchantId,
    type: 'BILLING_PROBLEM',
    title: isCanceled ? 'Subscription canceled' : 'Payment problem',
    body: isCanceled
      ? 'Your ReceipTap subscription was canceled. Resubscribe to keep your dashboard working.'
      : "We couldn't process your latest payment. Update your payment method to avoid interruption.",
    linkUrl: '/account/business/billing',
  });

  await sendBillingProblemEmailSafely(merchant, status);
  return notification;
}

async function sendBillingProblemEmailSafely(merchant, status) {
  try {
    await sendBillingProblemEmail({
      email: merchant.email,
      name: merchant.ownerName,
      businessName: merchant.businessName,
      status,
    });
  } catch (err) {
    console.error(`[merchantNotificationService] billing email to ${merchant.email} failed:`, err.message);
  }
}

// Fired when a POS OAuth refresh token fails -- a genuine "reconnect your
// POS" signal, not a one-off webhook blip (see the file comment in
// routes/webhooks.js's per-provider handlers for why a raw processing error
// isn't used as the trigger instead).
async function notifyPosConnectionFailed({ merchantId, provider }) {
  return create({
    merchantId,
    type: 'POS_CONNECTION_FAILED',
    title: `${provider} connection needs attention`,
    body: `ReceipTap lost its connection to ${provider}. Reconnect it so new sales keep coming through.`,
    linkUrl: '/account/business/pos',
  });
}

// Fired from services/stripeService.js's tryPayCommission, only when
// affiliate.merchantId is set -- a REGULAR affiliate is a wallet Customer,
// not a Merchant, and has no business-side notification feed to land in.
async function notifyPayoutCompleted({ merchantId, amountCents }) {
  const amountLabel = `$${(amountCents / 100).toFixed(2)}`;
  return create({
    merchantId,
    type: 'PAYOUT_COMPLETED',
    title: 'Partner Program payout sent',
    body: `${amountLabel} was paid out for your Partner Program referrals.`,
    linkUrl: '/account/business/referrals',
  });
}

// Fired from services/stripeService.js's plantTreeForRenewal, only after
// GoodAPI actually confirms the tree was planted -- never on a missing key,
// a GoodAPI outage, or a non-2xx response, so a merchant is never told (in
// app or by email) about a tree that wasn't actually planted. In-app AND
// email, unlike loyalty/POS/payout -- a thank-you for real money that just
// went out deserves to land in their inbox, not just the notification bell.
async function notifyTreePlanted({ merchantId }) {
  const treesPlanted = (await prisma.merchantNotification.count({
    where: { merchantId, type: 'TREE_PLANTED' },
  })) + 1;

  const notification = await create({
    merchantId,
    type: 'TREE_PLANTED',
    title: 'A tree was planted for your subscription',
    body: `Your ReceipTap subscription renewed this month, so we planted a real tree on your behalf. `
      + `That's ${treesPlanted} tree${treesPlanted === 1 ? '' : 's'} planted so far by staying subscribed.`,
    linkUrl: null,
  });

  await sendTreePlantedEmailSafely(merchantId, treesPlanted);
  return notification;
}

async function sendTreePlantedEmailSafely(merchantId, treesPlanted) {
  try {
    const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) return;
    await sendTreePlantedEmail({
      email: merchant.email,
      name: merchant.ownerName,
      businessName: merchant.businessName,
      treesPlanted,
      impactUrl: PUBLIC_IMPACT_URL,
    });
  } catch (err) {
    console.error(`[merchantNotificationService] tree-planted email for merchant ${merchantId} failed:`, err.message);
  }
}

async function listNotifications(merchantId) {
  return prisma.merchantNotification.findMany({
    where: { merchantId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}

function countUnread(merchantId) {
  return prisma.merchantNotification.count({ where: { merchantId, readAt: null } });
}

async function markAllRead(merchantId) {
  await prisma.merchantNotification.updateMany({
    where: { merchantId, readAt: null },
    data: { readAt: new Date() },
  });
}

module.exports = {
  notifyMerchantLoyaltyCardFilled,
  notifyBillingProblem,
  notifyPosConnectionFailed,
  notifyPayoutCompleted,
  notifyTreePlanted,
  listNotifications,
  countUnread,
  markAllRead,
};
