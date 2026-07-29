// routes/webhooks.js
// One shared endpoint per POS provider — handles every merchant on that provider.
// This is what makes the receipt route possible: it's where line items/totals
// actually get saved, before the customer ever taps.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const prisma = require('../lib/prisma');
const { fetchOrder } = require('../services/squareService');

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
        lineItems,
        subtotal: Number(order.total_money?.amount || 0) - Number(order.total_tax_money?.amount || 0),
        tax: Number(order.total_tax_money?.amount || 0),
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

module.exports = router;
