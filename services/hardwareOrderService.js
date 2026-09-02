// services/hardwareOrderService.js
// The standalone puck-shipping purchase flow the Terms ("Hardware (NFC
// pucks)" -> "Shipping") already disclose -- "a flat $25 USD charge per
// shipment... charged when you order a puck, not as part of starting or
// renewing your subscription." services/stripeService.js's own
// SHIPPING_FEE_CENTS comment used to describe this as "not built yet"; this
// file is that build. See prisma/schema.prisma's HardwareOrder model for why
// this never creates or assigns a Puck row -- that stays a manual pick from
// admin's inventory, same as always.
//
// Two kinds of buyer, same order/payment/shipping/tracking machinery either
// way (mirrors prisma's Affiliate model: one table, two ways in):
//   - a Merchant ordering pucks for their own registers
//   - a REGULAR affiliate ordering pucks to keep on hand and hand-deliver to
//     businesses they're signing up (a MERCHANT-type affiliate never reaches
//     this path -- they order through their own merchant account instead)
// Notification shape differs by buyer: a merchant gets an in-app
// notification AND email (services/merchantNotificationService.js, same as
// every other merchant-facing event); a REGULAR affiliate has no in-app feed
// to land in (same reasoning as notifyPayoutCompleted's own comment), so
// they get email only, handled directly in this file.

const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { stripe, SHIPPING_FEE_CENTS } = require('./stripeService');
const { hasCompleteAddress, createOutboundLabel, getTrackerStatus } = require('./easypostService');
const { notifyHardwareOrderPlaced, notifyHardwareOrderStatusChange } = require('./merchantNotificationService');
const { sendHardwareOrderConfirmationEmail, sendHardwareOrderStatusEmail } = require('./emailService');

const ORDER_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I, same reasoning as routes/admin.js's PUCK_ALPHABET

function randomOrderSuffix(length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ORDER_ALPHABET[crypto.randomInt(ORDER_ALPHABET.length)];
  }
  return out;
}

async function generateOrderNumber() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const orderNumber = `RT-${randomOrderSuffix(6)}`;
    const existing = await prisma.hardwareOrder.findUnique({ where: { orderNumber } });
    if (!existing) return orderNumber;
  }
  throw new Error('Could not generate a unique order number');
}

// Shared by createMerchantOrder/createAffiliateOrder below -- creates the
// HardwareOrder row and its matching one-time Stripe Checkout session.
// `owner` is `{ merchantId }` or `{ affiliateId }` (never both -- see
// prisma.HardwareOrder's own comment on why this is one table, two FKs).
async function createOrder(owner, addressSource, quantity, customerEmail, stripeCustomerId, successUrl, cancelUrl) {
  if (!stripe) throw new Error('Stripe is not configured yet.');
  if (!hasCompleteAddress(addressSource)) {
    throw new Error('Add a complete shipping address before ordering a ReceipTap.');
  }

  const orderNumber = await generateOrderNumber();
  const order = await prisma.hardwareOrder.create({
    data: {
      orderNumber,
      ...owner,
      quantity,
      shippingFeeCents: SHIPPING_FEE_CENTS,
      shippingName: addressSource.shippingName,
      shippingStreet1: addressSource.addressLine1,
      shippingStreet2: addressSource.addressLine2 || null,
      shippingCity: addressSource.addressCity,
      shippingRegion: addressSource.addressRegion,
      shippingPostalCode: addressSource.addressPostalCode,
      shippingCountry: addressSource.addressCountry,
      shippingPhone: addressSource.phone || null,
    },
  });

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: stripeCustomerId ? undefined : customerEmail,
    customer: stripeCustomerId || undefined,
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: `ReceipTap hardware shipping — ${orderNumber}` },
        unit_amount: SHIPPING_FEE_CENTS,
      },
      quantity: 1,
    }],
    metadata: { kind: 'hardware_order', hardwareOrderId: order.id },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  await prisma.hardwareOrder.update({
    where: { id: order.id },
    data: { stripeCheckoutSessionId: session.id },
  });

  return session.url;
}

/**
 * Creates a HardwareOrder + Stripe Checkout session for a merchant ordering
 * pucks for their own registers. Returns the URL to redirect them to.
 * Throws if Stripe isn't configured or their Business Settings address is
 * incomplete -- both are things the caller should show back to them, not
 * swallow.
 */
function createMerchantOrder(merchant, quantity, successUrl, cancelUrl) {
  return createOrder(
    { merchantId: merchant.id },
    {
      shippingName: merchant.businessName,
      addressLine1: merchant.addressLine1,
      addressLine2: merchant.addressLine2,
      addressCity: merchant.addressCity,
      addressRegion: merchant.addressRegion,
      addressPostalCode: merchant.addressPostalCode,
      addressCountry: merchant.addressCountry,
      phone: merchant.ownerPhone,
    },
    quantity,
    merchant.email,
    merchant.stripeCustomerId,
    successUrl,
    cancelUrl
  );
}

/**
 * Same as createMerchantOrder, for a REGULAR affiliate ordering pucks to
 * keep on hand. `affiliate` must already have its address* fields saved
 * (the order form collects/saves them before calling this -- see
 * routes/affiliates.js).
 */
function createAffiliateOrder(affiliate, quantity, successUrl, cancelUrl) {
  return createOrder(
    { affiliateId: affiliate.id },
    {
      shippingName: affiliate.name,
      addressLine1: affiliate.addressLine1,
      addressLine2: affiliate.addressLine2,
      addressCity: affiliate.addressCity,
      addressRegion: affiliate.addressRegion,
      addressPostalCode: affiliate.addressPostalCode,
      addressCountry: affiliate.addressCountry,
      phone: affiliate.phone,
    },
    quantity,
    affiliate.email,
    null, // affiliates don't have a Stripe customer id -- this is a one-off Checkout, not tied to their (nonexistent) subscription
    successUrl,
    cancelUrl
  );
}

/**
 * Marks a HardwareOrder PAID and hands it to the right notify path for its
 * buyer type. Idempotent: safe to call more than once for the same order
 * (e.g. once from the Checkout success-page redirect and again from the
 * Stripe webhook, if that's ever configured -- see the comment below on why
 * the redirect is the path actually relied on). Returns the order unchanged
 * if it's already past PENDING_PAYMENT.
 */
async function fulfillOrder(hardwareOrderId) {
  const order = await prisma.hardwareOrder.findUnique({ where: { id: hardwareOrderId } });
  if (!order) return null;
  if (order.status !== 'PENDING_PAYMENT') return order;

  const paid = await prisma.hardwareOrder.update({
    where: { id: order.id },
    data: { status: 'PAID', paidAt: new Date() },
  });

  if (paid.affiliateId) {
    return notifyAffiliateOrderPlaced(paid);
  }
  const result = await notifyHardwareOrderPlaced(paid);
  return result?.order || paid;
}

/**
 * Re-fetches a Checkout session by id and fulfills its order if Stripe
 * confirms it's actually paid. This is the path actually relied on:
 * CLAUDE.md notes no Stripe webhook secret is configured yet, so (same as
 * subscription checkout in routes/billing.js) the success-page redirect is
 * what does the real work, not /webhooks/stripe.
 */
async function fulfillOrderFromSessionId(sessionId) {
  if (!stripe || !sessionId) return null;
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.metadata?.kind !== 'hardware_order') return null;
  if (session.payment_status !== 'paid') return null;

  await prisma.hardwareOrder.update({
    where: { id: session.metadata.hardwareOrderId },
    data: { stripePaymentIntentId: session.payment_intent || null },
  }).catch(() => {}); // best-effort; fulfillOrder below is what actually matters

  return fulfillOrder(session.metadata.hardwareOrderId);
}

// Mirrors notifyHardwareOrderPlaced in services/merchantNotificationService.js
// (label purchase + email), minus the in-app notification a REGULAR
// affiliate has no feed to receive.
async function notifyAffiliateOrderPlaced(order) {
  const affiliate = await prisma.affiliate.findUnique({ where: { id: order.affiliateId } });
  if (!affiliate) return order;

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
  try {
    await sendHardwareOrderConfirmationEmail({
      email: affiliate.email,
      name: affiliate.name,
      businessName: affiliate.name,
      orderNumber: order.orderNumber,
      quantity: order.quantity,
      feeLabel,
      labelUrl: label?.labelUrl || null,
      trackingUrl: label?.trackingUrl || null,
    });
  } catch (err) {
    console.error(`[hardwareOrderService] order confirmation email for affiliate ${affiliate.id} failed:`, err.message);
  }

  return order;
}

// Mirrors notifyHardwareOrderStatusChange -- email only, same reasoning.
async function notifyAffiliateOrderStatusChange({ order, status }) {
  const affiliate = await prisma.affiliate.findUnique({ where: { id: order.affiliateId } });
  if (!affiliate) return;

  const isDelivered = status === 'DELIVERED';
  try {
    await sendHardwareOrderStatusEmail({
      email: affiliate.email,
      name: affiliate.name,
      businessName: affiliate.name,
      orderNumber: order.orderNumber,
      status: isDelivered ? 'delivered' : 'in_transit',
      trackingUrl: order.trackingUrl,
    });
  } catch (err) {
    console.error(`[hardwareOrderService] order status email for affiliate ${affiliate.id} failed:`, err.message);
  }
}

function getOrdersForMerchant(merchantId) {
  return prisma.hardwareOrder.findMany({
    where: { merchantId },
    orderBy: { createdAt: 'desc' },
  });
}

function getOrdersForAffiliate(affiliateId) {
  return prisma.hardwareOrder.findMany({
    where: { affiliateId },
    orderBy: { createdAt: 'desc' },
  });
}

// Maps EasyPost's tracker status vocabulary onto our own, smaller set.
// Anything not explicitly "in transit" or "delivered" (pre_transit, unknown,
// return_to_sender, failure, cancelled, error) is left as whatever status
// the order already has -- those aren't states this app surfaces separately,
// and a buyer with a stuck order still has the trackingUrl link to see the
// raw carrier status directly.
function mapTrackerStatus(easypostStatus) {
  if (easypostStatus === 'delivered') return 'DELIVERED';
  if (easypostStatus === 'in_transit' || easypostStatus === 'out_for_delivery' || easypostStatus === 'available_for_pickup') {
    return 'IN_TRANSIT';
  }
  return null;
}

/**
 * Polls EasyPost for every order still in flight (label bought, not yet
 * delivered) and updates + notifies on any genuine status transition. No
 * webhook is wired up for this -- EasyPost supports one, but it's another
 * manual dashboard-registration step, and this app already has an
 * established pattern (services/dataRetentionService.js,
 * services/warrantyReminderService.js) for a periodic in-memory check
 * instead. Called on an interval from server.js. Never throws: a single
 * order's lookup failing (EasyPost down, bad tracker id) is logged and
 * skipped, not allowed to stop the rest of the batch.
 */
async function refreshInFlightOrders() {
  const orders = await prisma.hardwareOrder.findMany({
    where: { status: { in: ['LABEL_PURCHASED', 'IN_TRANSIT'] }, easypostTrackerId: { not: null } },
  });

  let checked = 0;
  let updated = 0;

  for (const order of orders) {
    checked++;
    try {
      const easypostStatus = await getTrackerStatus(order.easypostTrackerId);
      const mapped = mapTrackerStatus(easypostStatus);
      if (!mapped || mapped === order.status) continue;

      const updatedOrder = await prisma.hardwareOrder.update({
        where: { id: order.id },
        data: {
          status: mapped,
          shippedAt: mapped === 'IN_TRANSIT' && !order.shippedAt ? new Date() : order.shippedAt,
          deliveredAt: mapped === 'DELIVERED' ? new Date() : order.deliveredAt,
        },
      });

      if (updatedOrder.affiliateId) {
        await notifyAffiliateOrderStatusChange({ order: updatedOrder, status: mapped });
      } else {
        await notifyHardwareOrderStatusChange({ order: updatedOrder, status: mapped });
      }
      updated++;
    } catch (err) {
      console.error(`[hardwareOrderService] tracking refresh failed for order ${order.orderNumber}:`, err.message);
    }
  }

  return { checked, updated };
}

module.exports = {
  createMerchantOrder,
  createAffiliateOrder,
  fulfillOrder,
  fulfillOrderFromSessionId,
  getOrdersForMerchant,
  getOrdersForAffiliate,
  refreshInFlightOrders,
};
