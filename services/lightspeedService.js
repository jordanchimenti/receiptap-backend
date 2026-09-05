// services/lightspeedService.js
// Lightspeed Retail (X-Series) -- NOT R-Series (the older, legacy Lightspeed
// Retail platform, a different API entirely) and NOT Lightspeed Restaurant.
// X-Series is what Lightspeed steers all new integrations toward as of this
// writing (date-based API versioning -- this file targets "2026-07").
//
// CORRECTED 2026-08-07 after the first real connection attempt failed
// ("Unable to connect application") against a real trial store. The
// original version of this file guessed three things wrong, each
// individually confirmed and fixed by fetching Lightspeed's own docs
// directly rather than guessing again: the token endpoint requires
// form-urlencoded bodies, not JSON; the scope strings follow a
// `resource:read`/`resource:write` pattern (sales:read, not
// employee:register_sale, which doesn't exist); and API endpoints live
// under a date-versioned path (/api/2026-07/..., not /api/2.0/...). A
// fourth gap found on the same pass: X-Series webhooks aren't a single
// app-level config the way Square's are -- each connected retailer needs
// its own webhook subscription created via a POST /webhooks call after
// OAuth, which createWebhookSubscription() below now does. Still not
// proven end-to-end against a real completed sale -- that's the next real
// test once the connection itself succeeds.

const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { notifyPosConnectionFailed } = require('./merchantNotificationService');

const LIGHTSPEED_AUTH_BASE_URL = 'https://secure.retail.lightspeed.app';
const LIGHTSPEED_API_VERSION = '2026-07';

// Every API call (including the token endpoint) is made against the
// retailer's own subdomain, not a shared host the way Square/Clover are --
// X-Series has no separate merchant ID, the domain prefix IS the identity.
function lightspeedApiBaseUrl(domainPrefix) {
  return `https://${domainPrefix}.retail.lightspeed.app`;
}

// A fresh token issued this recently is treated as still "new enough" to
// skip a refresh -- same reasoning as cloverService.js.
const REFRESH_SAFETY_MARGIN_MS = 60 * 1000;

// Scopes requested at connect time -- mandatory on every authorization
// request as of X-Series's 2026-06-01 change. sales:read/outlets:read/
// registers:read/taxes:read cover reading a completed sale's line items,
// totals, tax, and register/outlet info; webhooks is required separately
// to create the per-retailer webhook subscription below. products:read
// added 2026-08-09 -- a sale's line items only carry product.id, not a
// name, so this is needed to show real item names on a receipt rather than
// the generic "Item" fallback in routes/webhooks.js. customers:read added
// 2026-09-05 -- a sale only carries customer_id, not an email, so
// resolving it for card-recognition auto-save (routes/webhooks.js) needs
// this too. Any merchant who connected before a given scope was added
// needs to reconnect to actually be granted it -- adding one here doesn't
// retroactively upgrade existing tokens.
const LIGHTSPEED_SCOPES = 'sales:read outlets:read registers:read taxes:read products:read customers:read webhooks';

// Step 2 of OAuth: exchange the temporary authorization code for a token
// pair. domainPrefix comes back from Lightspeed alongside the code on the
// callback redirect -- the token endpoint lives on that retailer's own
// subdomain, not a shared host. Body MUST be form-urlencoded, not JSON --
// confirmed against Lightspeed's docs (unlike Square/Clover, which both
// use JSON here).
async function exchangeCodeForToken(domainPrefix, code, redirectUri) {
  const res = await fetch(`${lightspeedApiBaseUrl(domainPrefix)}/api/1.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.LIGHTSPEED_CLIENT_ID,
      client_secret: process.env.LIGHTSPEED_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`Failed to exchange Lightspeed code: ${res.status} ${await res.text()}`);
  return res.json(); // { access_token, refresh_token, expires_in, expires, domain_prefix, scope, token_type }
}

// The refresh token ROTATES on every use -- the previous one is revoked the
// moment a new pair is issued, so the caller must always persist BOTH
// tokens from the response, never just the access token.
async function refreshAccessToken(domainPrefix, refreshToken) {
  const res = await fetch(`${lightspeedApiBaseUrl(domainPrefix)}/api/1.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.LIGHTSPEED_CLIENT_ID,
      client_secret: process.env.LIGHTSPEED_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Failed to refresh Lightspeed token: ${res.status} ${await res.text()}`);
  return res.json();
}

// Creates this retailer's webhook subscription for sale.update events.
// Unlike Square (one app-level webhook signing key covers every merchant),
// X-Series requires each connected retailer to have its own webhook
// registered via API -- called once, right after OAuth completes. A 409
// means one already exists for this type+url (e.g. reconnecting after a
// disconnect/reconnect) -- treated as success, not an error.
async function createWebhookSubscription(domainPrefix, accessToken, url) {
  const res = await fetch(`${lightspeedApiBaseUrl(domainPrefix)}/api/${LIGHTSPEED_API_VERSION}/webhooks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: true, type: 'sale.update', url }),
  });
  if (res.status === 409) return; // already exists -- fine
  if (!res.ok) throw new Error(`Failed to create Lightspeed webhook: ${res.status} ${await res.text()}`);
  return res.json();
}

// Returns a definitely-valid access token for this merchant, refreshing
// (and persisting the new, rotated pair) first if the stored one is
// expired or about to be. Every Lightspeed API call should go through this
// rather than reading merchant.lightspeedAccessToken directly.
async function getValidAccessToken(merchant) {
  const stillFresh = merchant.lightspeedAccessTokenExpiresAt
    && merchant.lightspeedAccessTokenExpiresAt.getTime() - REFRESH_SAFETY_MARGIN_MS > Date.now();

  if (stillFresh) return merchant.lightspeedAccessToken;

  let refreshed;
  try {
    refreshed = await refreshAccessToken(merchant.lightspeedDomainPrefix, merchant.lightspeedRefreshToken);
  } catch (err) {
    // Same reasoning as cloverService.js's getValidAccessToken: a refresh
    // failure means the authorization itself is dead, which is worth
    // surfacing to the merchant, unlike a one-off API blip elsewhere.
    try {
      await notifyPosConnectionFailed({ merchantId: merchant.id, provider: 'Lightspeed' });
    } catch (notifyErr) {
      console.error('[lightspeedService] POS-connection-failed notification failed:', notifyErr.message);
    }
    throw err;
  }
  await prisma.merchant.update({
    where: { id: merchant.id },
    data: {
      lightspeedAccessToken: refreshed.access_token,
      lightspeedRefreshToken: refreshed.refresh_token,
      lightspeedAccessTokenExpiresAt: new Date(refreshed.expires * 1000),
    },
  });
  return refreshed.access_token;
}

// The sale.update webhook carries only the sale's ID and type -- no line
// items or totals -- so this fetches the real thing, same role as
// squareService's fetchOrder / cloverService's fetchOrder.
async function fetchSale(domainPrefix, accessToken, saleId) {
  const res = await fetch(
    `${lightspeedApiBaseUrl(domainPrefix)}/api/${LIGHTSPEED_API_VERSION}/sales/${saleId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Failed to fetch Lightspeed sale ${saleId}: ${res.status}`);
  const body = await res.json();
  return body.data || body;
}

// A sale's line items only carry product.id (confirmed against Lightspeed's
// own schema docs -- no batch-by-ID lookup exists on /products either), so
// showing a real item name on a receipt costs one call per unique product.
// Requires the products:read scope added to LIGHTSPEED_SCOPES above; a
// merchant who connected before that scope existed will get a 401/403 here
// until they reconnect -- callers should treat a failure as best-effort,
// same as everywhere else in this file.
async function fetchProduct(domainPrefix, accessToken, productId) {
  const res = await fetch(
    `${lightspeedApiBaseUrl(domainPrefix)}/api/${LIGHTSPEED_API_VERSION}/products/${productId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Failed to fetch Lightspeed product ${productId}: ${res.status}`);
  const body = await res.json();
  return body.data || body;
}

// A sale only carries customer_id (a UUID), never an email inline --
// confirmed against Lightspeed's own schema docs, the same way product
// names needed a separate lookup above. Requires the customers:read scope.
// Used for card-recognition auto-save (routes/webhooks.js's
// autoSaveReceiptForKnownShopper): the shopper's own wallet-recorded email
// is the thing actually matched against, this just resolves what X-Series
// calls that same shopper.
async function fetchCustomer(domainPrefix, accessToken, customerId) {
  const res = await fetch(
    `${lightspeedApiBaseUrl(domainPrefix)}/api/${LIGHTSPEED_API_VERSION}/customers/${customerId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Failed to fetch Lightspeed customer ${customerId}: ${res.status}`);
  const body = await res.json();
  return body.data || body;
}

// X-Series signs webhook deliveries with HMAC-SHA256 over the raw request
// body, keyed with the app's client_secret -- NOT the notification-URL-
// prefixed scheme Square uses. Header format:
// "X-Signature: signature=<hex>,algorithm=HMAC-SHA256".
function verifyLightspeedSignature(req) {
  const header = req.headers['x-signature'];
  const secret = process.env.LIGHTSPEED_CLIENT_SECRET;
  if (!header || !secret || !Buffer.isBuffer(req.body)) return false;

  const match = /signature=([^,]+)/.exec(header);
  if (!match) return false;
  const provided = Buffer.from(match[1]);

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(req.body)
    .digest('hex');
  const expected = Buffer.from(expectedSignature);

  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

module.exports = {
  LIGHTSPEED_AUTH_BASE_URL,
  LIGHTSPEED_API_VERSION,
  LIGHTSPEED_SCOPES,
  lightspeedApiBaseUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  getValidAccessToken,
  createWebhookSubscription,
  fetchSale,
  fetchProduct,
  fetchCustomer,
  verifyLightspeedSignature,
};
