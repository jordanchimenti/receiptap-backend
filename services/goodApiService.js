// services/goodApiService.js
// Plants one real tree via GoodAPI (thegoodapi.com) for every month a
// merchant's ReceipTap subscription actually gets charged and paid --
// nothing else. Best-effort: a GoodAPI outage or an unset key must never
// break billing, the same reasoning as notifyBillingProblemIfNewlyBad and
// tryPayCommission in services/stripeService.js never letting a side effect
// break the write that triggered it.

const GOODAPI_BASE_URL = 'https://app.thegoodapi.com';

// The public "ReceipTap impact" report (sharing enabled 2026-08-27) -- shown
// live on the landing page and linked from the tree-planted thank-you email.
// One constant so both places can never drift apart if this link is ever
// regenerated.
const PUBLIC_IMPACT_URL = 'https://app.thegoodapi.com/fe/share/lbwaj4l27l';

/**
 * Plants `count` trees. idempotencyKey should be deterministic per real-world
 * event (a transaction id, a Stripe invoice id) so a webhook redelivery can
 * never plant twice for the same sale or renewal -- GoodAPI enforces this
 * server-side given the same key, the same way Stripe idempotency keys work.
 * Returns null (never throws) on a missing key, a non-2xx response, or a
 * network failure -- callers treat null as "nothing happened, move on."
 */
async function plantTrees({ count, attribution, metadata, idempotencyKey }) {
  const apiKey = process.env.GOODAPI_API_KEY;
  if (!apiKey) {
    console.warn('[goodapi] GOODAPI_API_KEY not set, skipping tree planting');
    return null;
  }
  try {
    const response = await fetch(`${GOODAPI_BASE_URL}/plant/trees`, {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ count, attribution, metadata, idempotency_key: idempotencyKey }),
    });
    if (!response.ok) {
      console.error(`[goodapi] plant/trees failed: ${response.status} ${await response.text()}`);
      return null;
    }
    return await response.json();
  } catch (err) {
    console.error('[goodapi] plant/trees request failed:', err.message);
    return null;
  }
}

/**
 * One tree per successful monthly subscription charge. Called from
 * stripeService's invoice.payment_succeeded handler, which already guards
 * out $0 invoices (the free 30-day trial never generates a real charge) --
 * keyed on the invoice id so it plants once per billing period, not once per
 * webhook delivery.
 */
function plantTreeForSubscriptionMonth(merchant, invoice) {
  return plantTrees({
    count: 1,
    attribution: merchant.businessName || merchant.id,
    metadata: { merchantId: merchant.id, stripeInvoiceId: invoice.id },
    idempotencyKey: `receiptap-sub-month-${invoice.id}`,
  });
}

module.exports = { plantTrees, plantTreeForSubscriptionMonth, PUBLIC_IMPACT_URL };
