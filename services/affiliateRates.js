// services/affiliateRates.js
// Shared by routes/affiliates.js (dashboard display) and services/stripeService.js
// (commission calculation on payment) -- one place so the two rates can't drift apart.
// One flat rate for everyone, merchant-affiliate or standalone -- kept as two
// separate constants (rather than a single shared one) because they're
// conceptually different knobs that happen to be set equal right now, and
// every call site already looks up the right one by affiliate.type.
const MERCHANT_AFFILIATE_RATE = 20; // merchant referring another merchant, while their own subscription is ACTIVE
const REGULAR_AFFILIATE_RATE = 20; // standalone affiliate (future sales team), no eligibility condition

module.exports = { MERCHANT_AFFILIATE_RATE, REGULAR_AFFILIATE_RATE };
