// lib/affiliateReturnPath.js
// Same pattern as lib/posReturnPath.js -- a merchant-affiliate's Partner
// Program page now exists in two places (the real dashboard's
// /dashboard/referrals and the wallet's /account/business/referrals), so
// every redirect routes/affiliates.js issues for a MERCHANT-type affiliate
// (payout-frequency save, referral-code save, Stripe Connect onboarding
// return) needs to land back wherever the merchant actually came from,
// validated against this allowlist rather than trusted as-is.
const ALLOWED_AFFILIATE_RETURN_PATHS = ['/dashboard/referrals', '/account/business/referrals'];

function affiliateReturnPath(candidate) {
  return ALLOWED_AFFILIATE_RETURN_PATHS.includes(candidate) ? candidate : '/dashboard/referrals';
}

module.exports = { affiliateReturnPath };
