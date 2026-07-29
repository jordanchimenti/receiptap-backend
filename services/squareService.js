// services/squareService.js

const crypto = require('crypto');

const SQUARE_BASE_URL = process.env.SQUARE_APP_ID?.startsWith('sandbox-')
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com';

// Payment webhook events carry no line items or tax breakdown -- that data
// only lives on the associated Order, so webhooks.js fetches it separately
// using the merchant's own OAuth access token.
async function fetchOrder(accessToken, orderId) {
  const res = await fetch(`${SQUARE_BASE_URL}/v2/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': '2026-07-15' },
  });
  if (!res.ok) throw new Error(`Failed to fetch Square order ${orderId}: ${res.status}`);
  const { order } = await res.json();
  return order;
}

// Testing-only: rings a real sandbox sale (Order + Payment) using the
// elevated sandbox test-account token, NOT a merchant's own OAuth token --
// a real merchant's token is deliberately read-only and can't create these.
async function createTestSale(locationId, lineItems) {
  const testToken = process.env.SQUARE_SANDBOX_TEST_TOKEN;
  if (!testToken) throw new Error('SQUARE_SANDBOX_TEST_TOKEN is not set.');

  const orderRes = await fetch(`${SQUARE_BASE_URL}/v2/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${testToken}`, 'Content-Type': 'application/json', 'Square-Version': '2026-07-15' },
    body: JSON.stringify({
      order: {
        location_id: locationId,
        line_items: lineItems.map((li) => ({
          name: li.name,
          quantity: String(li.quantity),
          base_price_money: { amount: li.unitPrice, currency: 'CAD' },
        })),
      },
    }),
  });
  if (!orderRes.ok) throw new Error(`Failed to create Square order: ${orderRes.status} ${await orderRes.text()}`);
  const { order } = await orderRes.json();

  const paymentRes = await fetch(`${SQUARE_BASE_URL}/v2/payments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${testToken}`, 'Content-Type': 'application/json', 'Square-Version': '2026-07-15' },
    body: JSON.stringify({
      source_id: 'cnon:card-nonce-ok',
      idempotency_key: crypto.randomUUID(),
      amount_money: order.total_money,
      order_id: order.id,
      location_id: locationId,
    }),
  });
  if (!paymentRes.ok) throw new Error(`Failed to create Square payment: ${paymentRes.status} ${await paymentRes.text()}`);
  const { payment } = await paymentRes.json();

  return { order, payment };
}

module.exports = { SQUARE_BASE_URL, fetchOrder, createTestSale };
