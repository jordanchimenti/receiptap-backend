// lib/oauthState.js
// Shared helper for the Apple/Microsoft sign-in redirect flows (both the
// merchant routes in routes/auth.js and the customer routes in
// routes/customer-account.js use this). Unlike the POS providers, these
// are login/signup flows -- CSRF matters more here, so a nonce is stored
// in the session before redirecting out and checked again on the way
// back, in addition to whatever small bit of page context (which form the
// merchant started from, where to send them after) needs to survive the
// round trip to Apple/Microsoft and back.
const crypto = require('crypto');

function buildState(data) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const state = Buffer.from(JSON.stringify({ ...data, nonce })).toString('base64url');
  return { nonce, state };
}

// Returns null on anything malformed rather than throwing -- a tampered or
// expired state should just fail the sign-in, not crash the callback.
function parseState(state) {
  try {
    return JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = { buildState, parseState };
