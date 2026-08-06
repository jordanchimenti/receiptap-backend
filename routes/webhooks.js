// routes/webhooks.js
// One shared endpoint per POS provider — handles every merchant on that provider.
// This is what makes the receipt route possible: it's where line items/totals
// actually get saved, before the customer ever taps.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const prisma = require('../lib/prisma');
const { fetchOrder } = require('../services/squareService');
const { fetchOrder: fetchCloverOrder, getValidAccessToken: getValidCloverAccessToken } = require('../services/cloverService');

const CLAIM_WINDOW_MS = 3 * 60 * 1000; // how long a puck shows the live receipt before reverting

// Mounted with express.raw() in server.js (before the global express.json()),
// so req.body arrives here as the untouched raw Buffer Square actually signed —
// re-serializing an already-parsed object wouldn't byte-for-byte match it.
router.post('/webhooks/pos/square', async (req, res) => {
  if (!verifySquareSignature(req)) return res.sendStatus(401);

  try {
    const body = JSON.parse(req.body.toString('utf8'));

    // Square also sends order.created/order.updated and payment.created for
    // the same sale -- payment.updated reaching COMPLETED is the one moment
    // it's actually finalized. Acknowledge everything else without acting on it.
    if (body.type !== 'payment.updated') return res.sendStatus(200);

    const payment = body.data.object.payment;
    if (payment.status !== 'COMPLETED') return res.sendStatus(200);

    const merchant = await prisma.merchant.findFirst({ where: { squareMerchantId: body.merchant_id } });
    if (!merchant) return res.sendStatus(404); // event from a Square account we don't recognize

    // Square retries webhook delivery and sends multiple event types per
    // sale -- if this payment is already saved, just acknowledge and stop
    // rather than hitting Transaction.id's unique constraint.
    const existing = await prisma.transaction.findUnique({ where: { id: payment.id } });
    if (existing) return res.sendStatus(200);

    // Payments carry no line items or tax breakdown -- fetch the real order.
    const order = await fetchOrder(merchant.squareAccessToken, payment.order_id);
    const lineItems = (order.line_items || []).map((li) => ({
      name: li.name,
      quantity: parseInt(li.quantity, 10),
      unitPrice: Number(li.base_price_money?.amount || 0),
      total: Number(li.total_money?.amount || 0),
    }));

    const locationId = payment.location_id;
    const deviceId = payment.device_details?.device_id || null; // present for Terminal API sales, absent for simple POS-app sales

    const transaction = await prisma.transaction.create({
      data: {
        id: payment.id,
        merchantId: merchant.id,
        posProvider: 'square',
        posLocationId: locationId,
        posDeviceId: deviceId,
        orderNumber: payment.order_id || null,
        // The receipt should show when the sale actually happened at the
        // register, not whenever this webhook happened to get processed --
        // those can differ under retry/latency. Square reports this directly.
        createdAt: new Date(payment.created_at),
        lineItems,
        // Already net of any discount -- Square's total_money/total_tax_money
        // are computed post-discount, so discountTotal below is shown on the
        // receipt as an informational line, not subtracted a second time.
        subtotal: Number(order.total_money?.amount || 0) - Number(order.total_tax_money?.amount || 0),
        tax: Number(order.total_tax_money?.amount || 0),
        discountTotal: Number(order.total_discount_money?.amount || 0),
        total: Number(order.total_money?.amount || payment.total_money?.amount || 0),
        paymentMethod: payment.card_details?.card
          ? `${payment.card_details.card.card_brand} ••••${payment.card_details.card.last_4}`
          : null,
      },
    });

    // Find which puck sits at this specific register.
    // Prefer device-level match (handles multiple lanes at one location).
    // Fall back to location-level match (fine for single-register merchants,
    // or Square POS-app sales that don't report a device_id).
    let puck = null;
    if (deviceId) {
      puck = await prisma.puck.findFirst({
        where: { merchantId: merchant.id, posDeviceId: deviceId },
      });
    }
    if (!puck) {
      puck = await prisma.puck.findFirst({
        where: { merchantId: merchant.id, posLocationId: locationId, posDeviceId: null },
      });
    }

    if (puck) {
      await prisma.puck.update({
        where: { id: puck.id },
        data: {
          currentTransactionId: transaction.id,
          transactionExpiresAt: new Date(Date.now() + CLAIM_WINDOW_MS),
        },
      });
    }
    // If no puck is mapped to this location yet, the transaction is still saved —
    // it just won't be reachable by tap until the merchant assigns one.

    res.sendStatus(200);
  } catch (err) {
    console.error('Error processing Square webhook:', err);
    res.sendStatus(500); // tells Square to retry
  }
});

// Square's documented scheme: HMAC-SHA256 of (notification URL + raw body),
// base64-encoded, compared against the x-square-hmacsha256-signature header.
// SQUARE_WEBHOOK_URL must exactly match the Notification URL configured on
// the subscription in the Developer Dashboard — Square signs against that
// literal string, not whatever the request happens to arrive as.
function verifySquareSignature(req) {
  const signature = req.headers['x-square-hmacsha256-signature'];
  const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  const notificationUrl = process.env.SQUARE_WEBHOOK_URL;

  if (!signature || !signatureKey || !notificationUrl || !Buffer.isBuffer(req.body)) return false;

  const expectedSignature = crypto
    .createHmac('sha256', signatureKey)
    .update(notificationUrl + req.body.toString('utf8'))
    .digest('base64');

  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

// ---------------------------------------------------------------------------
// Clover: registered once in the Developer Dashboard (not created via an API
// call like Square's subscription), so this endpoint has to also handle the
// one-time verification handshake Clover does when the URL is first saved.
// Ongoing notifications carry no order data -- just which merchant and which
// object changed -- so every event means "go fetch the real thing."
// ---------------------------------------------------------------------------
router.post('/webhooks/pos/clover', async (req, res) => {
  const body = req.body;

  // One-time handshake: Clover POSTs this the moment the webhook URL is
  // saved in the Developer Dashboard. Log it -- the founder copies it back
  // into the dashboard's Webhooks section to confirm ownership of this URL.
  if (body.verificationCode) {
    console.log(`[clover webhook] Verification code (paste into Developer Dashboard > Webhooks): ${body.verificationCode}`);
    return res.sendStatus(200);
  }

  if (!verifyCloverAuth(req)) return res.sendStatus(401);

  try {
    const merchantEvents = body.merchants || {};
    for (const [cloverMerchantId, events] of Object.entries(merchantEvents)) {
      for (const event of events) {
        // Only orders represent a sale -- object IDs are prefixed with their
        // type ("O:" orders, "P:" payments, "I:" inventory, ...).
        if (!event.objectId || !event.objectId.startsWith('O:')) continue;
        await handleCloverOrderEvent(cloverMerchantId, event.objectId.slice(2));
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Error processing Clover webhook:', err);
    res.sendStatus(500); // tells Clover to retry
  }
});

async function handleCloverOrderEvent(cloverMerchantId, orderId) {
  const merchant = await prisma.merchant.findFirst({ where: { cloverMerchantId } });
  if (!merchant) return; // event from a Clover account we don't recognize

  const accessToken = await getValidCloverAccessToken(merchant);
  const order = await fetchCloverOrder(accessToken, cloverMerchantId, orderId);

  // OPEN | PAID | REFUNDED | CREDITED | PARTIALLY_PAID | PARTIALLY_REFUNDED --
  // only a fully completed sale should generate a receipt. An order can fire
  // several CREATE/UPDATE events while it's being built up before payment;
  // this re-checks the live order rather than trusting the event type.
  if (order.paymentState !== 'PAID') return;

  // Clover retries webhook delivery -- if this order is already saved, stop.
  const existing = await prisma.transaction.findUnique({ where: { id: order.id } });
  if (existing) return;

  // Best-effort field mapping -- Clover line items don't carry an explicit
  // quantity the way Square's do (a "3x Coffee" sale is 3 separate line item
  // elements, not one with quantity: 3), so each element maps to one line at
  // quantity 1 unless unitQty (scaled items, e.g. deli-by-weight) says
  // otherwise. Verify this against a real sandbox sale before fully trusting it.
  const lineItemElements = order.lineItems?.elements || [];
  const lineItems = lineItemElements.map((li) => {
    const quantity = li.unitQty ? Math.max(1, Math.round(li.unitQty / 1000)) : 1;
    return {
      name: li.name,
      quantity,
      unitPrice: quantity > 1 ? Math.round(li.price / quantity) : li.price,
      total: li.price,
    };
  });

  const paymentElements = order.payments?.elements || [];
  const cardTransaction = paymentElements[0]?.cardTransaction;
  const paymentMethod = cardTransaction
    ? `${cardTransaction.cardType || 'Card'} ••••${cardTransaction.last4 || ''}`
    : null;

  // Best-effort -- each line item can carry its own `discounts` array;
  // exact field names haven't been verified against a real sandbox order yet
  // (see the mapping note above), so this defaults to 0 rather than guessing wrong.
  const discountTotal = lineItemElements.reduce((sum, li) => {
    const lineDiscounts = (li.discounts || []).reduce((s, d) => s + (d.amount || 0), 0);
    return sum + lineDiscounts;
  }, 0);

  // Clover doesn't expose a total_tax_money-equivalent on the order the way
  // Square does, so tax is inferred rather than reported directly: subtotal
  // is the real sum of line item prices, and tax is whatever's left once
  // that (minus discount) is subtracted from the order's real total. Still
  // best-effort -- confirm against a real sandbox sale -- but strictly more
  // accurate than the flat "tax: 0" this used to hardcode for every order.
  const lineItemsSubtotal = lineItemElements.reduce((sum, li) => sum + (li.price || 0), 0);
  const inferredTax = Math.max(0, order.total - lineItemsSubtotal + discountTotal);

  const transaction = await prisma.transaction.create({
    data: {
      id: order.id,
      merchantId: merchant.id,
      posProvider: 'clover',
      posLocationId: cloverMerchantId, // a Clover merchant IS the location
      posDeviceId: null,
      orderNumber: order.id,
      // Same reasoning as the Square handler -- createdTime is when Clover
      // recorded the sale, not whenever this webhook got processed.
      createdAt: new Date(order.createdTime),
      lineItems,
      subtotal: lineItemsSubtotal,
      tax: inferredTax,
      discountTotal,
      total: order.total,
      paymentMethod,
    },
  });

  // A Clover connection is a single location -- no device-level lanes to
  // disambiguate between, unlike Square's multi-register handling.
  const puck = await prisma.puck.findFirst({
    where: { merchantId: merchant.id, posLocationId: cloverMerchantId, posDeviceId: null },
  });
  if (puck) {
    await prisma.puck.update({
      where: { id: puck.id },
      data: {
        currentTransactionId: transaction.id,
        transactionExpiresAt: new Date(Date.now() + CLAIM_WINDOW_MS),
      },
    });
  }
}

// Clover's X-Clover-Auth header carries a value shown in the Developer
// Dashboard's Webhooks section once configured -- set CLOVER_WEBHOOK_AUTH_TOKEN
// to that value to enable verification. Left unset, requests aren't rejected
// (verification is best-effort until that value is confirmed and configured).
function verifyCloverAuth(req) {
  const expected = process.env.CLOVER_WEBHOOK_AUTH_TOKEN;
  if (!expected) return true;
  return req.headers['x-clover-auth'] === expected;
}

module.exports = router;
