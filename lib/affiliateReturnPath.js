// lib/affiliateReturnPath.js
// Same pattern as lib/posReturnPath.js -- a merchant-affiliate's Partner
// Program page now exists in two places (the real dashboard's
// /dashboard/referrals and the wallet's /account/business/referrals), so
// every redirect routes/affiliates.js issues for a MERCHANT-type affiliate
// (payout-frequency save, referral-code save, Stripe Connect onboarding
// return) needs to land back wherever the merchant actually came from,
// validated against this allowlist rather than trusted as-is.
const ALLOWED_AFFILIATE_RETURN_PATHS = ['/dashboard/referrals', '/account/business/referrals'];

// The wallet, not the navy sidebar dashboard. Every caller that genuinely
// belongs on /dashboard/referrals names it explicitly -- the navy route passes
// redirectTo itself, and its forms round-trip that value -- so the fallback is
// only ever reached from somewhere that said nothing. Those are the personal
// and public surfaces (the wallet's More page, the customer wallet, the public
// landing page, the welcome screen), and sending a merchant from any of them
// to the old dashboard strands them on a surface they weren't using.
const DEFAULT_AFFILIATE_RETURN_PATH = '/account/business/referrals';

function affiliateReturnPath(candidate) {
  return ALLOWED_AFFILIATE_RETURN_PATHS.includes(candidate)
    ? candidate
    : DEFAULT_AFFILIATE_RETURN_PATH;
}

module.exports = { affiliateReturnPath, DEFAULT_AFFILIATE_RETURN_PATH, ALLOWED_AFFILIATE_RETURN_PATHS };
