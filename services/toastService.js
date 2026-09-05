// services/toastService.js
// Toast POS -- Standard API access. Deliberately NOT modeled on
// squareService.js/cloverService.js/lightspeedService.js's redirect-based
// OAuth: Toast's self-serve tier has no such flow. A restaurant on Toast
// RMS Essentials+ generates a static clientId/clientSecret themselves in
// their own Toast Web account (Manage Integrations permission required)
// and hands them to this app directly -- see routes/toast.js for that
// entry form. A real "any merchant clicks Connect" OAuth flow exists only
// for Toast's Partner Integration Program, a separate, gatekept business
// approval this app doesn't have.
//
// Built entirely from Toast's own published API docs
// (doc.toasttab.com/openapi/authentication, doc.toasttab.com/openapi/orders)
// -- unlike Lightspeed, this has NOT been verified against a real
// restaurant's live data, because doing so requires either an actual Toast
// customer's credentials or sandbox access Toast only grants on request.
// Treat field names here as doc-derived until a real connection proves
// them.

const prisma = require('../lib/prisma');
const { notifyPosConnectionFailed } = require('./merchantNotificationService');

const TOAST_API_BASE_URL = 'https://ws-api.toasttab.com';

// A token requested this recently is treated as still "new enough" to skip
// a re-request -- same reasoning as the other providers' safety margins,
// just a much bigger one here: Toast's authentication endpoint caps clients
// at 2 token requests per HOUR per IP (documented) and reserves the right to
// cut off API access over-requesting it, so this errs toward reusing a
// token for nearly its full ~24h lifetime rather than refreshing early.
const REFRESH_SAFETY_MARGIN_MS = 30 * 60 * 1000;

// Exchanges a restaurant's own clientId/clientSecret for an access token.
// Client-credentials style -- there's no user consent step and no
// authorization code; the static secret IS the credential. Called directly
// from routes/toast.js when a merchant first enters their credentials (to
// validate them before saving), and from getValidAccessToken below when the
// cached token has expired.
async function login(clientId, clientSecret) {
  const res = await fetch(`${TOAST_API_BASE_URL}/authentication/v1/authentication/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret, userAccessType: 'TOAST_MACHINE_CLIENT' }),
  });
  if (!res.ok) throw new Error(`Failed to authenticate with Toast: ${res.status} ${await res.text()}`);
  const body = await res.json();
  if (body.status !== 'SUCCESS' || !body.token?.accessToken) {
    throw new Error(`Toast authentication did not succeed: ${JSON.stringify(body)}`);
  }
  return body.token; // { tokenType, scope, expiresIn, accessToken, idToken, refreshToken }
}

// Returns a definitely-valid access token for this merchant, re-authenticating
// (with the same stored clientId/clientSecret -- Toast has no separate
// refresh-token grant documented, just re-login) and persisting it first if
// the cached one is expired or about to be.
async function getValidAccessToken(merchant) {
  const stillFresh = merchant.toastAccessTokenExpiresAt
    && merchant.toastAccessTokenExpiresAt.getTime() - REFRESH_SAFETY_MARGIN_MS > Date.now();

  if (stillFresh) return merchant.toastAccessToken;

  let token;
  try {
    token = await login(merchant.toastClientId, merchant.toastClientSecret);
  } catch (err) {
    // Same reasoning as the other providers' getValidAccessToken: a failure
    // here means the stored credentials are dead (revoked, restaurant's
    // Standard API access lapsed, etc.), worth surfacing to the merchant.
    try {
      await notifyPosConnectionFailed({ merchantId: merchant.id, provider: 'Toast' });
    } catch (notifyErr) {
      console.error('[toastService] POS-connection-failed notification failed:', notifyErr.message);
    }
    throw err;
  }

  const expiresAt = new Date(Date.now() + token.expiresIn * 1000);
  await prisma.merchant.update({
    where: { id: merchant.id },
    data: { toastAccessToken: token.accessToken, toastAccessTokenExpiresAt: expiresAt },
  });
  return token.accessToken;
}

// Full Order objects (checks, selections, payments, customer) for a time
// window -- the recommended endpoint over the deprecated GET /orders, which
// only returns bare GUIDs. startDate/endDate must not span more than 1 hour
// (Toast's own documented limit); services/toastPoller.js is what respects
// that, this function just makes the one call.
async function fetchOrdersBulk(restaurantGuid, accessToken, { startDate, endDate, page = 1, pageSize = 100 }) {
  const params = new URLSearchParams({
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    page: String(page),
    pageSize: String(pageSize),
  });
  const res = await fetch(`${TOAST_API_BASE_URL}/orders/v2/ordersBulk?${params}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      // Mandatory on every Orders API call -- omitting it is a 400, not a
      // default-to-some-restaurant behavior.
      'Toast-Restaurant-External-ID': restaurantGuid,
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch Toast orders: ${res.status} ${await res.text()}`);
  return res.json(); // array of full Order objects (not wrapped in a `data` envelope)
}

module.exports = {
  TOAST_API_BASE_URL,
  login,
  getValidAccessToken,
  fetchOrdersBulk,
};
