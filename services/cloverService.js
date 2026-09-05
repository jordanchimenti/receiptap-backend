// services/cloverService.js

const prisma = require('../lib/prisma');
const { notifyPosConnectionFailed } = require('./merchantNotificationService');

// Clover splits "authorize" (browser redirect) and "token/API calls" across
// two different domains -- unlike Square, which uses the same host for both.
// There's no naming convention on the App ID itself to tell sandbox from
// production apart (Square's sandbox IDs start with "sandbox-"), so this is
// an explicit env var instead. Defaults to sandbox -- production is opt-in.
const CLOVER_ENV = process.env.CLOVER_ENV === 'production' ? 'production' : 'sandbox';

const CLOVER_AUTH_BASE_URL = CLOVER_ENV === 'production'
  ? 'https://www.clover.com'
  : 'https://sandbox.dev.clover.com';

const CLOVER_API_BASE_URL = CLOVER_ENV === 'production'
  ? 'https://api.clover.com'
  : 'https://apisandbox.dev.clover.com';

// A fresh token issued this recently is treated as still "new enough" to
// skip a refresh -- avoids refreshing on every single call back-to-back.
const REFRESH_SAFETY_MARGIN_MS = 60 * 1000;

// Step 2 of OAuth: exchange the temporary authorization code for a token
// pair. Clover's v2/OAuth access tokens expire in ~30 minutes, unlike
// Square's, which don't expire -- see getValidAccessToken below.
async function exchangeCodeForToken(code) {
  const res = await fetch(`${CLOVER_API_BASE_URL}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.CLOVER_APP_ID,
      client_secret: process.env.CLOVER_APP_SECRET,
      code,
    }),
  });
  if (!res.ok) throw new Error(`Failed to exchange Clover code: ${res.status} ${await res.text()}`);
  return res.json(); // { access_token, access_token_expiration, refresh_token, refresh_token_expiration }
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(`${CLOVER_API_BASE_URL}/oauth/v2/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.CLOVER_APP_ID,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`Failed to refresh Clover token: ${res.status} ${await res.text()}`);
  return res.json();
}

// Returns a definitely-valid access token for this merchant, refreshing (and
// persisting the new pair) first if the stored one is expired or about to
// be. Every Clover API call should go through this rather than reading
// merchant.cloverAccessToken directly.
async function getValidAccessToken(merchant) {
  const stillFresh = merchant.cloverAccessTokenExpiresAt
    && merchant.cloverAccessTokenExpiresAt.getTime() - REFRESH_SAFETY_MARGIN_MS > Date.now();

  if (stillFresh) return merchant.cloverAccessToken;

  let refreshed;
  try {
    refreshed = await refreshAccessToken(merchant.cloverRefreshToken);
  } catch (err) {
    // A refresh failure means the authorization itself is dead (revoked,
    // expired refresh token) -- a genuine "reconnect Clover" signal, not a
    // one-off API blip, so it's the one POS failure point that's worth
    // surfacing to the merchant rather than just logging. Re-thrown after
    // notifying so the caller's existing error handling is unchanged.
    try {
      await notifyPosConnectionFailed({ merchantId: merchant.id, provider: 'Clover' });
    } catch (notifyErr) {
      console.error('[cloverService] POS-connection-failed notification failed:', notifyErr.message);
    }
    throw err;
  }
  await prisma.merchant.update({
    where: { id: merchant.id },
    data: {
      cloverAccessToken: refreshed.access_token,
      cloverRefreshToken: refreshed.refresh_token,
      cloverAccessTokenExpiresAt: new Date(refreshed.access_token_expiration * 1000),
    },
  });
  return refreshed.access_token;
}

// Webhook notifications carry only an object ID and event type -- no order
// data -- so this fetches the real thing, same role as squareService's
// fetchOrder. expand=lineItems,payments,customers pulls in what Square gives for free
// -- customers is what makes recognition possible on Clover at all, since
// Clover exposes no card identifier (see services/receiptAutoSave.js).
// on the payment webhook payload itself.
//
// Each expand field needs its OWN permission on the Clover app, separate
// from base order access -- this app's Requested Permissions only ever
// covered Merchant/Orders/Payments, never Customers, so the full
// lineItems+payments+customers expand has been throwing "Invalid
// permissions for expandable fields" on EVERY order since day one
// (discovered 2026-09-05). Confirmed directly against a real sandbox
// order: dropping just `customers` from the expand list succeeds and
// still returns full lineItems and payments -- so this tries three tiers,
// each strictly worse than the last, rather than jumping straight from
// "everything" to "nothing":
//   1. Full expand -- works once Customers read is added in the
//      Developer Dashboard (App Settings -> Requested Permissions) and
//      every connected merchant reconnects afterward.
//   2. lineItems+payments only -- works right now, with today's
//      permissions. A receipt built from this has real items and card
//      details, just no card-based recognition (see
//      services/receiptAutoSave.js) since that needs the customer object
//      this tier omits.
//   3. No expand at all -- last resort if even that fails for some other
//      reason. Confirmed to still return 200 with just id/total/currency/
//      paymentState/createdTime.
// The caller already treats a missing lineItems/payments/customers as
// "none reported" (`?.elements || []`), so every tier below produces a
// real receipt, just with progressively less on it, instead of losing the
// sale entirely to a permissions gap outside this app's control.
async function fetchOrder(accessToken, cloverMerchantId, orderId) {
  const tiers = [
    { expand: 'lineItems,payments,customers', warn: null },
    {
      expand: 'lineItems,payments',
      warn: 'Customers permission is missing on the Clover app (Developer Dashboard -> ' +
        'App Settings -> Requested Permissions) -- receipt has items and payment details but no card-based recognition.',
    },
    { expand: null, warn: 'lineItems/payments permissions are missing too -- receipt has no items or payment details at all.' },
  ];

  let lastStatus;
  for (const tier of tiers) {
    const url = tier.expand
      ? `${CLOVER_API_BASE_URL}/v3/merchants/${cloverMerchantId}/orders/${orderId}?expand=${tier.expand}`
      : `${CLOVER_API_BASE_URL}/v3/merchants/${cloverMerchantId}/orders/${orderId}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.ok) {
      if (tier.warn) console.error(`[cloverService] order ${orderId}: ${tier.warn}`);
      return res.json();
    }
    lastStatus = res.status;
  }
  throw new Error(`Failed to fetch Clover order ${orderId}: ${lastStatus}`);
}

module.exports = {
  CLOVER_ENV,
  CLOVER_AUTH_BASE_URL,
  CLOVER_API_BASE_URL,
  exchangeCodeForToken,
  refreshAccessToken,
  getValidAccessToken,
  fetchOrder,
};
