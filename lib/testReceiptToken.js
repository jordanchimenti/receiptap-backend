// lib/testReceiptToken.js
// A short-lived signed token that lets a merchant open their own test receipt
// on a phone that isn't logged in — the point of a test sale being to see the
// receipt the way a customer does, on a real device.
//
// Why a token rather than a real sale: a test sale used to mean writing an
// actual Transaction, which is why it was restricted to demo accounts (see the
// comment on the old /dashboard/settings/receipt/test-sale route). A single
// test row in a live merchant's data would land in their revenue, their
// receipt counts, their analytics and their exports — 26 separate queries
// would each need to remember to exclude it, and the first one that forgot
// would quietly overstate someone's takings. This writes nothing at all.
//
// What the token grants is deliberately tiny: the right to render a SAMPLE
// receipt carrying that merchant's own public branding — the same logo and
// colours printed on every receipt they hand out. No customer data, no real
// transaction, and it stops working within the day.

const crypto = require('crypto');

const TTL_MS = 24 * 60 * 60 * 1000;

function secret() {
  // Same secret sessions are signed with. If it's unset the app is already in
  // its insecure dev default, and this is no worse than that.
  return process.env.SESSION_SECRET || 'dev-secret-change-in-production';
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

function createTestReceiptToken(merchantId) {
  const payload = `${merchantId}.${Date.now() + TTL_MS}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

/** Returns the merchantId, or null if the token is missing, forged or expired. */
function verifyTestReceiptToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;

  const [encoded, providedSignature] = token.split('.');
  if (!encoded || !providedSignature) return null;

  let payload;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch (err) {
    return null;
  }

  const expected = sign(payload);
  // Constant-time compare, and length-checked first because timingSafeEqual
  // throws on a length mismatch rather than returning false.
  const a = Buffer.from(providedSignature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const [merchantId, expiresAt] = payload.split('.');
  if (!merchantId || !expiresAt || Number(expiresAt) < Date.now()) return null;

  return merchantId;
}

module.exports = { createTestReceiptToken, verifyTestReceiptToken, TTL_MS };
