// services/squareService.js

const prisma = require('./../lib/prisma');
const { notifyPosConnectionFailed } = require('./merchantNotificationService');

const SQUARE_BASE_URL = process.env.SQUARE_APP_ID?.startsWith('sandbox-')
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com';

// A fresh token issued this recently is treated as still "new enough" to
// skip a refresh -- same reasoning and value as cloverService.js's own
// margin, avoids refreshing on every single call back-to-back.
const REFRESH_SAFETY_MARGIN_MS = 60 * 1000;

// Square's /oauth2/token endpoint handles both the initial authorization-code
// exchange (routes/oauth-square.js) and refreshes (below) -- same shape
// either way: { access_token, refresh_token, expires_at (ISO string,
// unlike Clover's unix-seconds field), merchant_id, token_type }.
async function refreshAccessToken(refreshToken) {
  const res = await fetch(`${SQUARE_BASE_URL}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SQUARE_APP_ID,
      client_secret: process.env.SQUARE_APP_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Failed to refresh Square token: ${res.status} ${await res.text()}`);
  return res.json();
}

// Returns a definitely-valid access token for this merchant, refreshing (and
// persisting the new pair) first if the stored one is expired or about to
// be. Every Square API call in this app should go through this rather than
// reading merchant.squareAccessToken directly -- see that field's schema
// comment for why (it used to be treated as never expiring, which was
// wrong, and the gap ran silently in production for weeks).
async function getValidAccessToken(merchant) {
  const stillFresh = merchant.squareAccessTokenExpiresAt
    && merchant.squareAccessTokenExpiresAt.getTime() - REFRESH_SAFETY_MARGIN_MS > Date.now();

  if (stillFresh) return merchant.squareAccessToken;

  // A merchant connected before this fix has an access token but no
  // refresh token on file at all -- nothing to refresh with, so this is
  // the same "reconnect" signal as an actual refresh failure below, not a
  // separate case to special-case.
  if (!merchant.squareRefreshToken) {
    try {
      await notifyPosConnectionFailed({ merchantId: merchant.id, provider: 'Square' });
    } catch (notifyErr) {
      console.error('[squareService] POS-connection-failed notification failed:', notifyErr.message);
    }
    throw new Error(`Merchant ${merchant.id} has no Square refresh token on file -- must reconnect`);
  }

  let refreshed;
  try {
    refreshed = await refreshAccessToken(merchant.squareRefreshToken);
  } catch (err) {
    // A refresh failure means the authorization itself is dead (revoked,
    // expired refresh token) -- a genuine "reconnect Square" signal, not a
    // one-off API blip, so it's the one POS failure point worth surfacing
    // to the merchant rather than just logging. Re-thrown after notifying
    // so the caller's existing error handling is unchanged.
    try {
      await notifyPosConnectionFailed({ merchantId: merchant.id, provider: 'Square' });
    } catch (notifyErr) {
      console.error('[squareService] POS-connection-failed notification failed:', notifyErr.message);
    }
    throw err;
  }

  await prisma.merchant.update({
    where: { id: merchant.id },
    data: {
      squareAccessToken: refreshed.access_token,
      squareRefreshToken: refreshed.refresh_token,
      squareAccessTokenExpiresAt: new Date(refreshed.expires_at),
    },
  });
  return refreshed.access_token;
}

// Payment webhook events carry no line items or tax breakdown -- that data
// only lives on the associated Order, so webhooks.js fetches it separately
// using a valid (refreshed if needed) access token.
async function fetchOrder(accessToken, orderId) {
  const res = await fetch(`${SQUARE_BASE_URL}/v2/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Square-Version': '2026-07-15' },
  });
  if (!res.ok) throw new Error(`Failed to fetch Square order ${orderId}: ${res.status}`);
  const { order } = await res.json();
  return order;
}

module.exports = { SQUARE_BASE_URL, refreshAccessToken, getValidAccessToken, fetchOrder };
