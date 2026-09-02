// services/merchantNotificationService.js
// Everything a merchant gets told about, in one place -- the business-side
// equivalent of services/notificationService.js (customer-facing), same
// philosophy: the database row is the record of record, written first and
// always. Most types are in-app only; billing problems and tree-planted
// thank-yous deliberately also go by email -- see sendBillingProblemEmailSafely
// and sendTreePlantedEmailSafely below for why those two are different.

const prisma = require('../lib/prisma');
const {
  sendBillingProblemEmail, sendTreePlantedEmail, sendReturnPucksEmail,
  sendHardwareOrderConfirmationEmail, sendHardwareOrderStatusEmail,
} = require('./emailService');
const { PUBLIC_IMPACT_URL } = require('./goodApiService');
const { createReturnLabel, createOutboundLabel } = require('./easypostService');

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

// Fired from services/stripeService.js's syncPuckReturnWindows, right after
// it starts a return window on a merchant's currently-unreturned pucks --
// the actual mechanism behind the Terms' "we'll notify you" return promise
// (Hardware section), which had nothing behind it at all before this.
// Attempts a real prepaid label via services/easypostService.js first
// (best-effort -- see createReturnLabel's own doc comment for every reason
// that can fail) and persists it on the Merchant row if it worked, but
// sends the email regardless of whether a label came back. Email, not just
// in-app: this is the one channel that reaches a merchant who used
// "Deactivate account," since that flow destroys their session immediately
// and they can never log back in to see an in-app notification.
async function notifyReturnPucks({ merchantId, puckCount, deadline }) {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) return null;

  const label = await createReturnLabel(merchant);
  if (label) {
    await prisma.merchant.update({
      where: { id: merchantId },
      data: {
        returnLabelUrl: label.labelUrl,
        returnTrackingCode: label.trackingCode,
        returnTrackingUrl: label.trackingUrl,
        returnLabelGeneratedAt: new Date(),
      },
    });
  }

  const notification = await create({
    merchantId,
    type: 'RETURN_PUCKS',
    title: puckCount === 1 ? 'Return your ReceipTap puck' : `Return your ${puckCount} ReceipTap pucks`,
    body: `Due back by ${deadline.toLocaleDateString('en-US', { dateStyle: 'long' })}`
      + (label ? ' — your prepaid shipping label is ready.' : '.'),
    linkUrl: '/account/business/pucks/return',
  });

  await sendReturnPucksEmailSafely({ merchant, puckCount, deadline, label });
  return notification;
}

async function sendReturnPucksEmailSafely({ merchant, puckCount, deadline, label }) {
  try {
    await sendReturnPucksEmail({
      email: merchant.email,
      name: merchant.ownerName,
      businessName: merchant.businessName,
      puckCount,
      deadline,
      labelUrl: label?.labelUrl || null,
      trackingUrl: label?.trackingUrl || null,
    });
  } catch (err) {
    console.error(`[merchantNotificationService] return-pucks email for merchant ${merchant.id} failed:`, err.message);
  }
}

// Fired from services/hardwareOrderService.js's fulfillOrder, right after a
// HardwareOrder's payment is confirmed -- mirrors notifyReturnPucks above,
// opposite direction: this ships a puck TO the merchant instead of tracking
// one going back. Attempts a real prepaid label via
// services/easypostService.js first (best-effort, same reasoning as
// createReturnLabel) and persists it on the order if it worked, but notifies
// and emails regardless of whether a label came back.
async function notifyHardwareOrderPlaced(order) {
  const merchant = await prisma.merchant.findUnique({ where: { id: order.merchantId } });
  if (!merchant) return null;

  const label = await createOutboundLabel(order);
  if (label) {
    order = await prisma.hardwareOrder.update({
      where: { id: order.id },
      data: {
        status: 'LABEL_PURCHASED',
        labelUrl: label.labelUrl,
        trackingCode: label.trackingCode,
        trackingUrl: label.trackingUrl,
        easypostTrackerId: label.trackerId,
      },
    });
  }

  const feeLabel = `$${(order.shippingFeeCents / 100).toFixed(2)} USD`;
  const notification = await create({
    merchantId: order.merchantId,
    type: 'HARDWARE_ORDER_PLACED',
    title: `Order confirmed — ${order.orderNumber}`,
    body: `${order.quantity === 1 ? '1 ReceipTap' : `${order.quantity} ReceipTaps`}, ${feeLabel} shipping paid`
      + (label ? ' — your prepaid label is ready.' : '.'),
    linkUrl: '/account/business/orders',
  });

  await sendHardwareOrderConfirmationEmailSafely({ merchant, order, feeLabel, label });
  return { order, notification };
}

async function sendHardwareOrderConfirmationEmailSafely({ merchant, order, feeLabel, label }) {
  try {
    await sendHardwareOrderConfirmationEmail({
      email: merchant.email,
      name: merchant.ownerName,
      businessName: merchant.businessName,
      orderNumber: order.orderNumber,
      quantity: order.quantity,
      feeLabel,
      labelUrl: label?.labelUrl || null,
      trackingUrl: label?.trackingUrl || null,
    });
  } catch (err) {
    console.error(`[merchantNotificationService] order confirmation email for merchant ${merchant.id} failed:`, err.message);
  }
}

// Fired from services/hardwareOrderService.js's tracking-refresh job, only
// on a genuine status TRANSITION (IN_TRANSIT or DELIVERED) -- never on every
// poll, so a merchant isn't renotified each time the job runs and the
// carrier status hasn't actually changed.
async function notifyHardwareOrderStatusChange({ order, status }) {
  const merchant = await prisma.merchant.findUnique({ where: { id: order.merchantId } });
  if (!merchant) return null;

  const isDelivered = status === 'DELIVERED';
  const notification = await create({
    merchantId: order.merchantId,
    type: isDelivered ? 'HARDWARE_ORDER_DELIVERED' : 'HARDWARE_ORDER_SHIPPED',
    title: isDelivered ? `Delivered — ${order.orderNumber}` : `On its way — ${order.orderNumber}`,
    body: isDelivered
      ? 'Tap it and enter the claim code on the insert card to link it to your account.'
      : 'Your ReceipTap order is on its way.',
    linkUrl: '/account/business/orders',
  });

  await sendHardwareOrderStatusEmailSafely({ merchant, order, status: isDelivered ? 'delivered' : 'in_transit' });
  return notification;
}

async function sendHardwareOrderStatusEmailSafely({ merchant, order, status }) {
  try {
    await sendHardwareOrderStatusEmail({
      email: merchant.email,
      name: merchant.ownerName,
      businessName: merchant.businessName,
      orderNumber: order.orderNumber,
      status,
      trackingUrl: order.trackingUrl,
    });
  } catch (err) {
    console.error(`[merchantNotificationService] order status email for merchant ${merchant.id} failed:`, err.message);
  }
}

// Fired by hand from /admin/announce (routes/admin.js) -- a policy/price
// change, or anything else worth telling every merchant about at once.
// There's no bulk/automated email sender in this app (see
// docs/LEGAL_REVIEW_NOTES.md items 9 and 13), so the Notifications tab is
// the actual delivery mechanism, not a supplement to one. createMany
// rather than a loop of individual creates -- one round trip regardless of
// merchant count. Deactivated merchants are skipped: they can't sign in to
// read it anyway, and their data is on its own purge clock already.
async function notifyAllMerchantsOfAnnouncement({ title, body, linkUrl }) {
  const merchants = await prisma.merchant.findMany({ where: { isActive: true }, select: { id: true } });
  if (merchants.length === 0) return { count: 0 };

  const result = await prisma.merchantNotification.createMany({
    data: merchants.map((m) => ({ merchantId: m.id, type: 'ANNOUNCEMENT', title, body, linkUrl: linkUrl || null })),
  });
  return { count: result.count };
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
  notifyReturnPucks,
  notifyHardwareOrderPlaced,
  notifyHardwareOrderStatusChange,
  notifyAllMerchantsOfAnnouncement,
  listNotifications,
  countUnread,
  markAllRead,
};
