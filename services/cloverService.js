// services/cloverService.js

const prisma = require('../lib/prisma');

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

  const refreshed = await refreshAccessToken(merchant.cloverRefreshToken);
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
// fetchOrder. expand=lineItems,payments pulls in what Square gives for free
// on the payment webhook payload itself.
async function fetchOrder(accessToken, cloverMerchantId, orderId) {
  const res = await fetch(
    `${CLOVER_API_BASE_URL}/v3/merchants/${cloverMerchantId}/orders/${orderId}?expand=lineItems,payments`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Failed to fetch Clover order ${orderId}: ${res.status}`);
  return res.json();
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
