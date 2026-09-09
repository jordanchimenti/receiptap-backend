// services/paypalService.js
// PayPal's equivalent of services/stripeService.js's Shopper Connect
// functions -- lets a guest's Split the Bill PayPal payment route straight
// into the host's own PayPal account (Orders v2, payee.merchant_id, no
// platform fee) instead of the plain paypal.me deep link
// (Customer.paypalMeHandle) that's shown when a shopper hasn't connected a
// real account. ReceipTap's own PayPal balance never holds this money.
//
// Uses PayPal's REST API directly via fetch (no SDK dependency) -- the
// surface area needed here (OAuth, Partner Referrals, Orders v2, webhook
// verification) is small enough that a client library would add more
// weight than it saves.
const prisma = require('../lib/prisma');

const PAYPAL_API_BASE = 'https://api-m.sandbox.paypal.com';

const configured = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

// Cached in memory, same reasoning as any short-lived OAuth token: PayPal's
// client-credentials tokens last ~9 hours, so re-fetching one on every
// request would be pure waste. Refreshed 60 seconds before actual expiry to
// leave room for the request itself.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  if (!configured) throw new Error('PayPal is not configured yet (missing PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET).');
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;

  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal OAuth token request failed: ${res.status}`);
  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function paypalFetch(path, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${PAYPAL_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `PayPal API error: ${res.status}`);
    err.status = res.status;
    err.paypalDetails = data;
    throw err;
  }
  return data;
}

/** Creates a Partner Referral -- the hosted onboarding link a shopper
 * follows to connect their own PayPal account, PayPal's equivalent of
 * Stripe Connect's accountLinks.create. tracking_id is our own customer id,
 * which comes back on the return redirect as `merchantId` so we know whose
 * onboarding this was without needing a session at that point (mirrors how
 * Stripe Connect's return route re-derives everything from the signed-in
 * session instead, but Partner Referrals' return redirect is the only
 * signal PayPal gives us, so it has to carry the id itself). */
async function createPartnerReferral(customer, returnUrl) {
  const body = {
    tracking_id: customer.id,
    partner_config_override: { return_url: returnUrl },
    operations: [
      {
        operation: 'API_INTEGRATION',
        api_integration_preference: {
          rest_api_integration: {
            integration_method: 'PAYPAL',
            integration_type: 'THIRD_PARTY',
            third_party_details: { features: ['PAYMENT', 'REFUND'] },
          },
        },
      },
    ],
    products: ['EXPRESS_CHECKOUT'],
    legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }],
    individual_owners: [{ email: customer.email }],
  };

  const data = await paypalFetch('/v2/customer/partner-referrals', { method: 'POST', body: JSON.stringify(body) });
  const actionLink = (data.links || []).find((l) => l.rel === 'action_url');
  if (!actionLink) throw new Error('PayPal did not return an onboarding action_url.');
  return actionLink.href;
}

/** The return-url query params alone (merchantIdInPayPal, permissionsGranted,
 * etc.) aren't enough to know a seller can actually receive payments --
 * PayPal's own docs say to follow up with this "show seller status" call
 * and check payments_receivable/primary_email_confirmed, same reasoning as
 * getShopperConnectStatus's payoutsEnabled check in stripeService.js.
 * Requires PAYPAL_PARTNER_MERCHANT_ID -- ReceipTap's own PayPal merchant
 * id (Account Settings -> Business information -> PayPal Merchant ID on
 * paypal.com), not a secret, just an identifier. */
async function getSellerStatus(merchantIdInPayPal) {
  const partnerId = process.env.PAYPAL_PARTNER_MERCHANT_ID;
  if (!partnerId) throw new Error('PayPal is not configured yet (missing PAYPAL_PARTNER_MERCHANT_ID).');
  const data = await paypalFetch(`/v1/customer/partners/${partnerId}/merchant-integrations/${merchantIdInPayPal}`);
  return {
    paymentsReceivable: Boolean(data.payments_receivable),
    primaryEmailConfirmed: Boolean(data.primary_email_confirmed),
  };
}

/** Creates the real Orders v2 order a guest's PayPal button confirms
 * against on the public guest page -- same "server computes the amount,
 * never trusts the client" rule as createSplitPaymentIntent in
 * stripeService.js. No platform_fees entry, so the full amount routes to
 * the host's own connected account; ReceipTap's balance never holds it.
 *
 * The item selection (itemDescriptions) can't travel in Orders v2's
 * custom_id the way it did in Stripe's PaymentIntent metadata -- custom_id
 * caps at 127 characters. A PendingPaypalOrder row carries it instead,
 * read back by handleWebhookEvent below once the payment actually
 * completes. */
async function createSplitOrder({ amountCents, currency, payeeMerchantId, groupId, itemDescriptions }) {
  const order = await paypalFetch('/v2/checkout/orders', {
    method: 'POST',
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          custom_id: groupId,
          payee: { merchant_id: payeeMerchantId },
          amount: { currency_code: currency.toUpperCase(), value: (amountCents / 100).toFixed(2) },
        },
      ],
    }),
  });

  await prisma.pendingPaypalOrder.create({
    data: { orderId: order.id, groupId, amountCents, itemDescriptions },
  });

  return order;
}

/** Captures an approved order -- called from the guest page once the
 * PayPal button's own onApprove fires. Recording the payment as real,
 * though, still only ever happens from the PAYMENT.CAPTURE.COMPLETED
 * webhook below, same as Stripe's confirmPayment()/webhook split: a
 * guest's browser finishing this call proves nothing on its own. */
async function captureOrder(orderId) {
  return paypalFetch(`/v2/checkout/orders/${orderId}/capture`, { method: 'POST' });
}

/** Verifies a webhook actually came from PayPal, via PayPal's own
 * server-side verification call rather than a local signature computation
 * (unlike Stripe's stripe.webhooks.constructEvent) -- PayPal's API takes
 * the already-parsed JSON body directly, so no raw-body middleware is
 * needed for this route (see server.js's express.raw exceptions, which
 * intentionally do NOT include /webhooks/paypal). */
async function verifyWebhookSignature(headers, body) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) throw new Error('PayPal is not configured yet (missing PAYPAL_WEBHOOK_ID).');

  const data = await paypalFetch('/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    body: JSON.stringify({
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: webhookId,
      webhook_event: body,
    }),
  });
  return data.verification_status === 'SUCCESS';
}

/** Records a guest's successful Split the Bill PayPal payment as a real
 * SplitPayment and flips its covered items to paid -- the PayPal mirror of
 * recordSplitPaymentFromIntent in stripeService.js. Idempotent the same
 * way: SplitPayment.paypalOrderId's unique constraint turns a retried
 * webhook delivery into a harmless no-op. Silently does nothing for a
 * capture this app didn't create the PendingPaypalOrder row for -- this
 * app's PayPal account could in principle receive other event types later. */
async function handleWebhookEvent(event) {
  if (event.event_type !== 'PAYMENT.CAPTURE.COMPLETED') return;

  const capture = event.resource;
  const orderId = capture?.supplementary_data?.related_ids?.order_id;
  if (!orderId) return;

  const existing = await prisma.splitPayment.findUnique({ where: { paypalOrderId: orderId } });
  if (existing) return;

  const pending = await prisma.pendingPaypalOrder.findUnique({ where: { orderId } });
  if (!pending) return; // not a Split the Bill order this app created

  const group = await prisma.splitGroup.findUnique({ where: { id: pending.groupId } });
  if (!group) return;

  const selectedDescriptions = Array.isArray(pending.itemDescriptions) ? pending.itemDescriptions : [];
  const selectedSet = new Set(selectedDescriptions);
  const items = Array.isArray(group.items) ? group.items : [];
  const updatedItems = items.map((it) => (selectedSet.has(it.description) ? { ...it, paid: true } : it));

  try {
    await prisma.$transaction([
      prisma.splitPayment.create({
        data: {
          groupId: group.id,
          guestId: null,
          amountCents: pending.amountCents,
          itemDescriptions: selectedDescriptions,
          method: 'paypal',
          paypalOrderId: orderId,
        },
      }),
      prisma.splitGroup.update({ where: { id: group.id }, data: { items: updatedItems } }),
      prisma.pendingPaypalOrder.delete({ where: { orderId } }),
    ]);
  } catch (err) {
    // Unique constraint race (two near-simultaneous webhook deliveries) --
    // harmless, the first delivery already recorded this payment.
    if (err.code !== 'P2002') throw err;
  }
}

module.exports = {
  configured,
  createPartnerReferral,
  getSellerStatus,
  createSplitOrder,
  captureOrder,
  verifyWebhookSignature,
  handleWebhookEvent,
};
