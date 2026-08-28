// services/squareService.js

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

module.exports = { SQUARE_BASE_URL, fetchOrder };
