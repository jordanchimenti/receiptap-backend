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
//
// SEVEN YEARS, not the two this used to be. The old window quietly destroyed
// the very thing the product exists to keep: CRA requires business records be
// kept SIX YEARS from the end of the last tax year they relate to, so a
// receipt dated early in a year must survive nearly seven from its own date.
// The US limitation periods sit inside that -- three years normally, six where
// more than 25% of income was omitted, seven for bad-debt claims.
//
// This is deliberately the longest of those, because a shorter window is
// unrecoverable: a purged receipt cannot be un-purged when someone is audited.
// It is a real privacy cost (PIPEDA and GDPR both say do not keep personal
// data longer than the purpose needs), and the purpose that justifies it is
// tax substantiation -- which is exactly what this product promises.
//
// [[REVIEW: confirm with counsel before publishing. The number drives the
// retention paragraph in BOTH privacy policies automatically.]]
const SHOPPER_RECEIPT_MONTHS = 84;

// A shopper's account-level data (Customer.email, name, login) follows a
// separate clock from any single receipt: once EVERY receipt tied to them
// has aged out (see SHOPPER_RECEIPT_MONTHS) and they have no other active
// relationship keeping the account alive, the account itself is eligible.
// Kept as its own named constant rather than reusing SHOPPER_RECEIPT_MONTHS
// -- these are conceptually different things that currently happen to share
// a number, and a future privacy policy could reasonably set them apart.
const SHOPPER_ACCOUNT_MONTHS = 84;

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
