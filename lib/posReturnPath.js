// lib/posReturnPath.js
// Shared by all four OAuth route files (oauth-square.js, oauth-clover.js,
// oauth-lightspeed.js, oauth-shopify.js). Each provider's `state` param is
// round-tripped through their own login page unmodified but was never
// actually read back on any of the four callbacks -- it just carried
// merchantId, which the callback already has from req.session anyway. This
// repurposes that same round-trip to carry a validated return path instead,
// the same allowlist reasoning as lib/safeRedirect.js's safeNextPath, kept
// separate since this validates an OAuth `state` value, not a next-path
// query param.
const ALLOWED_POS_RETURN_PATHS = ['/dashboard/pos-setup', '/account/business/pos'];

function posReturnPath(state) {
  return ALLOWED_POS_RETURN_PATHS.includes(state) ? state : '/dashboard/pos-setup';
}

module.exports = { posReturnPath };
