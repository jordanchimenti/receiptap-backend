// config/payouts.js
// Single source of truth for the Instant Withdrawal fee ReceipTap shows a
// host on the Withdraw screen (routes/customer-payouts.js).
//
// IMPORTANT: this number is NOT enforced by this codebase. Stripe's own
// Platform Pricing Tool (dashboard.stripe.com/settings/connect/platform_pricing/instant_payouts)
// is what actually deducts an Application Fee from an Instant Payout --
// Stripe applies it automatically because ReceipTap is already the fee
// payer on these connected accounts (destination charges make the platform
// the fee payer regardless of any other account setting -- see the "Host
// balance / withdrawals" section of services/stripeService.js). The real
// amount a host receives always comes back from Stripe's own
// instant_available.net_available balance figure at withdrawal time, never
// a locally computed "amount * 0.97".
//
// So this constant is display copy only, shown on the Withdraw screen
// before the real Stripe-computed figure is fetched. Changing it WITHOUT
// ALSO changing the Dashboard's Platform Pricing Tool percentage to match
// makes the UI lie about the real fee -- bump both in the same change.
const INSTANT_WITHDRAWAL_FEE_PERCENT = 3;

module.exports = { INSTANT_WITHDRAWAL_FEE_PERCENT };
