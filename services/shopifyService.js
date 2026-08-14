// services/shopifyService.js
// Shopify POS -- the in-person register app run from a Shopify store, NOT
// the online storefront. A "shop" (myshopify.com domain) IS the merchant --
// no separate merchant ID the way Lightspeed's domain prefix works, but
// unlike Lightspeed the classic OAuth access token here is OFFLINE and does
// NOT expire (confirmed against Shopify's own OAuth docs -- the response has
// no expires_in field for offline tokens), so no refresh logic and no
// expiresAt column needed, unlike Clover/Lightspeed.

const crypto = require('crypto');

const SHOPIFY_API_VERSION = '2026-07';

// Every API call (including token exchange and webhook creation) is made
// against the merchant's own *.myshopify.com domain -- there is no shared
// host the way Square/Clover's API is.
function shopifyAdminBaseUrl(shopDomain) {
  return `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}`;
}

// Only real *.myshopify.com domains are ever valid here -- guards both the
// connect-form input and the callback's shop param against being used to
// build a request against an attacker-controlled host.
const SHOP_DOMAIN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
function isValidShopDomain(shopDomain) {
  return typeof shopDomain === 'string' && SHOP_DOMAIN_PATTERN.test(shopDomain);
}

// Scopes requested at connect time. read_orders covers reading a completed
// sale's line items/totals; that's all a receipt needs to render.
const SHOPIFY_SCOPES = 'read_orders';

// Step 1's URL, built here rather than in the route so the HMAC-verification
// pairing with verifyOAuthCallback lives next to each other.
function buildAuthorizeUrl(shopDomain, redirectUri, state) {
  const params = new URLSearchParams({
    client_id: process.env.SHOPIFY_CLIENT_ID,
    scope: SHOPIFY_SCOPES,
    redirect_uri: redirectUri,
    state,
  });
  return `https://${shopDomain}/admin/oauth/authorize?${params}`;
}

// Shopify signs the OAuth callback's own query string (separate from, and
// differently encoded than, the webhook body signature below) -- confirms
// the redirect actually came from Shopify and wasn't forged. Per Shopify's
// documented algorithm: drop hmac itself, sort the rest alphabetically as
// key=value joined with &, HMAC-SHA256 keyed with the app's client secret,
// compared as a HEX digest (not base64 -- that's the webhook signature's
// encoding, this is a different check).
function verifyOAuthCallback(query) {
  const { hmac, ...rest } = query;
  if (!hmac) return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${Array.isArray(rest[key]) ? rest[key].join(',') : rest[key]}`)
    .join('&');

  const expectedHex = crypto
    .createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET)
    .update(message)
    .digest('hex');

  const provided = Buffer.from(hmac);
  const expected = Buffer.from(expectedHex);
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

// Step 2: exchange the temporary code for an offline access token. Body
// MUST be form-urlencoded (confirmed against Shopify's docs) -- like
// Lightspeed, unlike Square/Clover's JSON.
async function exchangeCodeForToken(shopDomain, code) {
  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      code,
    }),
  });
  if (!res.ok) throw new Error(`Failed to exchange Shopify code: ${res.status} ${await res.text()}`);
  return res.json(); // { access_token, scope } -- no expires_in for an offline token
}

// Registers this shop's orders/paid webhook subscription -- like Lightspeed
// (and unlike Square's single app-level Notification URL), each connected
// shop needs its own subscription created via API, called once right after
// OAuth completes. Shopify responds 422 (not 409) when one already exists
// for this topic+address -- e.g. reconnecting after a disconnect -- treated
// as success, not an error.
async function createWebhookSubscription(shopDomain, accessToken, address) {
  const res = await fetch(`${shopifyAdminBaseUrl(shopDomain)}/webhooks.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ webhook: { topic: 'orders/paid', address, format: 'json' } }),
  });
  if (res.status === 422) return; // already exists -- fine
  if (!res.ok) throw new Error(`Failed to create Shopify webhook: ${res.status} ${await res.text()}`);
  return res.json();
}

// Shopify signs every webhook delivery with HMAC-SHA256 over the raw
// request body, keyed with the app's client secret, base64-encoded --
// different encoding than the OAuth callback's hex digest above. Header:
// X-Shopify-Hmac-Sha256.
function verifyShopifyWebhook(req) {
  const header = req.headers['x-shopify-hmac-sha256'];
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!header || !secret || !Buffer.isBuffer(req.body)) return false;

  const expectedBase64 = crypto
    .createHmac('sha256', secret)
    .update(req.body)
    .digest('base64');

  const provided = Buffer.from(header, 'base64');
  const expected = Buffer.from(expectedBase64, 'base64');
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

module.exports = {
  SHOPIFY_API_VERSION,
  SHOPIFY_SCOPES,
  shopifyAdminBaseUrl,
  isValidShopDomain,
  buildAuthorizeUrl,
  verifyOAuthCallback,
  exchangeCodeForToken,
  createWebhookSubscription,
  verifyShopifyWebhook,
};
