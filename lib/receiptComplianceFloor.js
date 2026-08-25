// lib/receiptComplianceFloor.js
//
// The fields a receipt cannot legally do without, forced on at render time.
//
// Receipt design is a wall of switches, and six of them turn off things a
// receipt has to carry for the customer to claim the purchase back: the
// seller's name, the date, the tax charged, the total, the tax registration
// number, and -- above a threshold -- what was actually bought. A merchant
// flipping switches had no way to know they had just made every receipt they
// issue useless for an input tax credit.
//
// Applied here rather than in the layouts because there are three of them and
// nothing stops a fourth being added. A guard that has to be remembered in
// nine places is a guard that eventually isn't. This runs once, on the way in,
// so every layout present and future inherits it.
//
// It deliberately overrides STORED values rather than only fixing them on
// save: rows already sitting in the database with these switched off (there is
// at least one known cause -- see saveReceiptSettings' blockFlags marker) must
// not keep producing deficient receipts until someone re-saves the page.

// CRA requires a description of each supply once a purchase reaches $500
// (raised from $150 by SOR/2021-63, effective April 20, 2021). Below that a
// merchant may legitimately prefer a receipt without line detail -- a
// pharmacy or a clinic has good reason not to itemise into someone's wallet
// -- so the preference is honoured where the requirement doesn't reach.
const ITEM_DETAIL_REQUIRED_FROM_CENTS = 50000;

/**
 * @param {object} theme        the merchant's ReceiptTheme (or the safe default)
 * @param {object} transaction  raw transaction; `total` and `tax` in CENTS
 * @returns {object} a copy of the theme with the non-negotiable fields forced on
 */
function applyComplianceFloor(theme, transaction) {
  const t = { ...theme };

  // No receipt is valid without these, and no design preference outranks them.
  t.showBusinessName = true;
  t.showDateTime = true;
  t.showTotal = true;

  // Harmless when the merchant has no registration number: every layout also
  // checks gstHstNumber is actually set before printing a line for it.
  t.showTaxNumber = true;

  // Forced only when tax was actually charged. With none charged there is
  // nothing to substantiate and a "$0.00" line is just noise, so the
  // merchant's own preference still stands.
  const taxCents = Number(transaction && transaction.tax);
  if (Number.isFinite(taxCents) && taxCents > 0) t.showTax = true;

  const totalCents = Number(transaction && transaction.total);
  if (Number.isFinite(totalCents) && totalCents >= ITEM_DETAIL_REQUIRED_FROM_CENTS) {
    t.showItemQuantity = true;
    t.showItemUnitPrice = true;
    t.showItemLineTotal = true;
  }

  return t;
}

module.exports = { applyComplianceFloor, ITEM_DETAIL_REQUIRED_FROM_CENTS };
