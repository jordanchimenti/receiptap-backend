// routes/webhooks.js
// One shared endpoint per POS provider — handles every merchant on that provider.
// This is what makes the receipt route possible: it's where line items/totals
// actually get saved, before the customer ever taps.

const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const CLAIM_WINDOW_MS = 3 * 60 * 1000; // how long a puck shows the live receipt before reverting

router.post('/webhooks/pos/square', express.json(), async (req, res) => {
  if (!verifySquareSignature(req)) return res.sendStatus(401);

  const payload = req.body.data.object;
  const squareMerchantId = req.body.merchant_id;
  const locationId = payload.location_id;
  const deviceId = payload.device_id || null; // present for Terminal API sales, absent for simple POS-app sales

  const merchant = await prisma.merchant.findFirst({ where: { squareMerchantId } });
  if (!merchant) return res.sendStatus(404); // event from a Square account we don't recognize

  // Save the transaction — this is the data the receipt page reads later
  const lineItems = payload.line_items.map((li) => ({
    name: li.name,
    quantity: parseInt(li.quantity, 10),
    unitPrice: li.base_price_money.amount,
    total: li.total_money.amount,
  }));

  const transaction = await prisma.transaction.create({
    data: {
      id: payload.id,
      merchantId: merchant.id,
      posProvider: 'square',
      posLocationId: locationId,
      posDeviceId: deviceId,
      lineItems,
      subtotal: payload.total_money.amount - (payload.total_tax_money?.amount || 0),
      tax: payload.total_tax_money?.amount || 0,
      total: payload.total_money.amount,
      paymentMethod: payload.tenders?.[0]?.card_details
        ? `${payload.tenders[0].card_details.card.card_brand} ••••${payload.tenders[0].card_details.card.last_4}`
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
});

function verifySquareSignature(req) {
  // Implement using Square's signature key + the raw request body.
  // Placeholder — replace with actual HMAC verification before going live.
  return true;
}

module.exports = router;
