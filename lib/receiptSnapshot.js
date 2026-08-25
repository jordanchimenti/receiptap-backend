// lib/receiptSnapshot.js
//
// The seller identity/tax snapshot: what gets frozen onto a Transaction row
// at creation time (buildSellerSnapshot, the WRITE side) and how a render
// path turns a transaction back into the `seller` object every receipt
// template displays (resolveSellerForRender, the READ side). Merchant and
// ReceiptTheme stay fully mutable -- this module is the only place either
// direction crosses between "what's true right now" and "what a specific
// receipt says was true on its own sale date."
//
// Both functions fail LOUD on a caller mistake rather than silently falling
// back to a live join -- a silent fallback is exactly the bug this snapshot
// exists to remove, and a wrong-but-quiet answer here is worse than a thrown
// error, since nothing else would ever catch it.

/**
 * WRITE side. Called once, at Transaction creation time, by every POS
 * webhook handler (routes/webhooks.js) and the demo-tier test-sale route
 * (routes/theme-settings.js) -- always off the SAME `merchant` row each
 * already loads with `include: { receiptTheme: true }`, never a second
 * query (this codebase has a known Postgres connection-pool limit; see
 * CLAUDE.md's Prisma client gotcha).
 *
 * `merchant.receiptTheme` must be `null` (no ReceiptTheme row exists yet --
 * a real, reachable state for a merchant who's connected a POS but never
 * opened Business/Theme Settings) or the actual ReceiptTheme object. It must
 * NEVER be `undefined` -- that means the caller's query didn't include the
 * relation at all, which silently produces the exact same all-null snapshot
 * as the genuine no-theme-row case, indistinguishable to anyone reading the
 * data later. Guarded here, at the one place both cases funnel through,
 * rather than trusting every current and future call site to remember the
 * include.
 */
function buildSellerSnapshot(merchant) {
  if (merchant.receiptTheme === undefined) {
    throw new Error(
      'buildSellerSnapshot: merchant.receiptTheme is undefined. ' +
      'The caller must fetch the merchant with `include: { receiptTheme: true }` ' +
      '(or an equivalent `select`) -- without it this would silently write a snapshot ' +
      'of nulls indistinguishable from a genuine "no ReceiptTheme row yet" merchant.'
    );
  }
  const theme = merchant.receiptTheme; // null is the genuine no-theme-row case

  return {
    sellerName: (theme && theme.displayName) || merchant.businessName,
    sellerLegalName: merchant.businessName,
    sellerAddressLine1: merchant.addressLine1,
    sellerAddressLine2: merchant.addressLine2,
    sellerAddressCity: merchant.addressCity,
    sellerAddressRegion: merchant.addressRegion,
    sellerAddressPostalCode: merchant.addressPostalCode,
    sellerAddressCountry: merchant.addressCountry,
    sellerGstHstNumber: theme ? theme.gstHstNumber : null,
    sellerTaxNumberLabel: theme ? theme.taxNumberLabel : null,
    sellerTaxNumber2: theme ? theme.taxNumber2 : null,
    sellerTaxNumber2Label: theme ? theme.taxNumber2Label : null,
    sellerTaxLabel: (theme && theme.taxLabel) || 'Tax',
  };
}

/**
 * READ side. Called by every route that renders views/receipt.ejs or
 * views/receipt-warranty.ejs (routes/receipt.js, routes/demo.js,
 * routes/theme-settings.js's live preview), which pass the result as the
 * `seller` local -- the templates never compute this themselves or duck-type
 * on the shape of `transaction`.
 *
 * `isSynthetic: true` is an explicit, caller-set flag for the two contexts
 * with no real sale to snapshot: the live theme-editing preview
 * (theme-settings.js, reflecting a merchant's unsaved edits) and the
 * marketing demo (demo.js, a hand-built sample transaction). Both fall back
 * to the live theme/merchant values -- there is nothing to freeze, since
 * nothing was actually sold. `transaction` is ignored entirely in this
 * branch, since a synthetic transaction was never written by
 * buildSellerSnapshot and has no seller* fields to read.
 *
 * Anything else -- `isSynthetic` unset or false -- MUST have a real
 * `sellerName` on the transaction. A missing one is a bug: a query that used
 * `select` without it, a transaction created before this snapshot existed
 * with no backfill, or some other transaction-shaped object entirely. This
 * throws rather than falling back to `theme`/`merchant`, which is exactly
 * the live-join behavior this snapshot was built to remove -- a silent
 * revert here would be indistinguishable from "working" until someone
 * noticed a receipt had quietly started drifting again.
 */
function resolveSellerForRender(transaction, { theme, merchant, isSynthetic = false }) {
  if (isSynthetic) {
    return {
      name: theme.displayName || merchant.businessName,
      legalName: merchant.businessName,
      addressLine1: merchant.addressLine1,
      addressLine2: merchant.addressLine2,
      addressCity: merchant.addressCity,
      addressRegion: merchant.addressRegion,
      addressPostalCode: merchant.addressPostalCode,
      addressCountry: merchant.addressCountry,
      gstHstNumber: theme.gstHstNumber,
      taxNumberLabel: theme.taxNumberLabel,
      taxNumber2: theme.taxNumber2,
      taxNumber2Label: theme.taxNumber2Label,
      taxLabel: theme.taxLabel || 'Tax',
    };
  }

  if (transaction.sellerName == null) {
    throw new Error(
      'resolveSellerForRender: transaction is missing its seller snapshot (sellerName) ' +
      'and isSynthetic was not set. Either this transaction predates the ' +
      'receipt_seller_snapshot migration with no backfill, or a query used `select` ' +
      'without the seller* fields -- both need fixing at the source, not a fallback here.'
    );
  }

  return {
    name: transaction.sellerName,
    legalName: transaction.sellerLegalName,
    addressLine1: transaction.sellerAddressLine1,
    addressLine2: transaction.sellerAddressLine2,
    addressCity: transaction.sellerAddressCity,
    addressRegion: transaction.sellerAddressRegion,
    addressPostalCode: transaction.sellerAddressPostalCode,
    addressCountry: transaction.sellerAddressCountry,
    gstHstNumber: transaction.sellerGstHstNumber,
    taxNumberLabel: transaction.sellerTaxNumberLabel,
    taxNumber2: transaction.sellerTaxNumber2,
    taxNumber2Label: transaction.sellerTaxNumber2Label,
    taxLabel: transaction.sellerTaxLabel,
  };
}

module.exports = { buildSellerSnapshot, resolveSellerForRender };
