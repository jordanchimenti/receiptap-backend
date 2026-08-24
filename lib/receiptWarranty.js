// lib/receiptWarranty.js
//
// How long a purchase is covered, and who decided.
//
// Same shape as lib/receiptDeductible.js: the model estimates from what was
// bought (aiWarrantyMonths), the customer's own number -- if they give one --
// always wins (warrantyMonths). Unlike deductibility, this isn't a claim
// about the customer's personal circumstances; a typical manufacturer or
// store warranty length is a fact about the product, so the model is allowed
// to answer it directly. The customer still wins when they know better --
// they bought AppleCare, or the "12 months" guess was for the wrong item.
//
// warrantyExpiresAt is stored, not derived on read. computeWarrantyExpiry()
// below is the ONLY place that math happens, called from both the
// categorization write path (services/categorize-receipt.js) and the
// customer-override route (routes/customer-account.js) -- so a receipt can
// never show one expiry on screen and trigger a reminder against a
// different one, the same drift risk deductibleWhereClause guards against.

/** @returns {number|null} the number of months actually in effect for this receipt. */
function effectiveWarrantyMonths(receipt) {
  if (!receipt) return null;
  if (typeof receipt.warrantyMonths === 'number') return receipt.warrantyMonths;
  if (typeof receipt.aiWarrantyMonths === 'number') return receipt.aiWarrantyMonths;
  return null;
}

/**
 * @param {Date|null} purchaseDate
 * @param {number|null} months
 * @returns {Date|null} null if there's no purchase date, no months, or months <= 0
 *   (0 is how a customer explicitly says "no warranty" -- see the schema comment).
 */
function computeWarrantyExpiry(purchaseDate, months) {
  if (!purchaseDate || typeof months !== 'number' || months <= 0) return null;
  // setUTCMonth, not setMonth: a ScannedReceipt.purchaseDate is stored as
  // UTC midnight with no time-of-day meaning (lib/receiptDateLabels.js), and
  // local-time month arithmetic on a UTC-midnight instant drifts by an hour
  // across a DST transition -- Jan 15 + 3 months landing on Apr 14 23:00
  // instead of Apr 15 00:00, silently a day early for scanning/display.
  const expiry = new Date(purchaseDate);
  expiry.setUTCMonth(expiry.getUTCMonth() + months);
  return expiry;
}

/** @returns {'customer'|'ai'|'none'} what the current estimate rests on. */
function warrantySource(receipt) {
  if (!receipt) return 'none';
  if (typeof receipt.warrantyMonths === 'number') return 'customer';
  if (typeof receipt.aiWarrantyMonths === 'number') return 'ai';
  return 'none';
}

module.exports = {
  effectiveWarrantyMonths,
  computeWarrantyExpiry,
  warrantySource,
};
