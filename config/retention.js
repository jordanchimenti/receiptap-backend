// config/retention.js
// Single source of truth for every retention window in the app.
// services/dataRetentionService.js, the scheduled purge job, any dashboard
// copy describing "how long we keep your data," and the eventual published
// privacy policy must all read these values -- nothing else in the codebase
// is allowed to hardcode a duration.
//
// VERSION-BUMP RULE (same spirit as config/legal.js): changing any window
// below is a promise-breaking or promise-making change to whatever the
// privacy policy ends up saying about retention. Do it in the same change
// that updates the published policy, not separately.

// Shopper-side receipts: the Transaction row, its lineItems, and everything
// that cascades from it (ShopperConsent rows tied to that receiptId) age out
// this many months after Transaction.createdAt.
const SHOPPER_RECEIPT_MONTHS = 24;

// A shopper's account-level data (Customer.email, name, login) follows a
// separate clock from any single receipt: once EVERY receipt tied to them
// has aged out (see SHOPPER_RECEIPT_MONTHS) and they have no other active
// relationship keeping the account alive, the account itself is eligible.
// Kept as its own named constant rather than reusing SHOPPER_RECEIPT_MONTHS
// -- these are conceptually different things that currently happen to share
// a number, and a future privacy policy could reasonably set them apart.
const SHOPPER_ACCOUNT_MONTHS = 24;

// A merchant who deactivates (Merchant.isActive = false) gets this many
// days of grace before their data is actually purged -- long enough to
// notice and reverse an accidental deactivation, or handle a support
// request, before it's gone for good.
const DEACTIVATED_MERCHANT_PURGE_DAYS = 90;

// LegalAcceptance rows are retained INDEFINITELY -- no purge window at all.
// They are the compliance record proving a specific merchant agreed to a
// specific version of the Terms/Privacy/DPA at a specific time, and must
// survive the deletion/purge of everything else about that merchant.
// services/dataRetentionService.js deliberately never touches this table.
// Represented as Infinity (not null or a sentinel) so "is this row older
// than the window" arithmetic naturally never trips true, rather than
// needing a special-cased branch for "no expiry."
const LEGAL_ACCEPTANCE_RETENTION_MONTHS = Infinity;

// EmailSuppression rows (Part D) are the other deliberate exception to
// SHOPPER_ACCOUNT_MONTHS: when a shopper unsubscribes or is deleted, their
// receipts/account are purged on the normal clock, but the suppression
// record survives indefinitely so a future receipt claim can't silently
// re-enroll them in marketing. Also Infinity, same reasoning as above.
const EMAIL_SUPPRESSION_RETENTION_MONTHS = Infinity;

module.exports = {
  SHOPPER_RECEIPT_MONTHS,
  SHOPPER_ACCOUNT_MONTHS,
  DEACTIVATED_MERCHANT_PURGE_DAYS,
  LEGAL_ACCEPTANCE_RETENTION_MONTHS,
  EMAIL_SUPPRESSION_RETENTION_MONTHS,
};
