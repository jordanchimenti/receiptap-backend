// lib/receiptDeductible.js
//
// Whether a receipt counts as tax deductible, and who decided.
//
// Two columns, deliberately, on both Transaction and ScannedReceipt:
//
//   aiTaxDeductible  what services/categorize-receipt.js concluded
//   taxDeductible    what the customer said, if they've said anything
//
// The customer's answer always wins, and null means they haven't given one --
// which is why this isn't a single column the AI overwrites. Collapsing them
// would mean a re-categorisation could silently flip a receipt the customer
// had already ruled on, on their tax return, without telling them.
//
// Nothing here is tax advice. The AI's call is a starting point the customer
// is expected to correct; `source` exists so the UI can be honest about which
// of the two is currently speaking.

/** @returns {boolean} the effective answer -- what an export should act on. */
function isDeductible(receipt) {
  if (!receipt) return false;
  if (typeof receipt.taxDeductible === 'boolean') return receipt.taxDeductible;
  if (typeof receipt.aiTaxDeductible === 'boolean') return receipt.aiTaxDeductible;
  // Never assessed (categorisation is best-effort and can fail): claiming it
  // is the mistake with a cost attached, so an unknown receipt stays out.
  return false;
}

/** @returns {'customer'|'ai'|'none'} who the current answer came from. */
function deductibleSource(receipt) {
  if (!receipt) return 'none';
  if (typeof receipt.taxDeductible === 'boolean') return 'customer';
  if (typeof receipt.aiTaxDeductible === 'boolean') return 'ai';
  return 'none';
}

/** True once the customer has overridden the AI in either direction. */
function isCustomerDecided(receipt) {
  return deductibleSource(receipt) === 'customer';
}

/**
 * True when the customer's answer contradicts the AI's -- the case worth
 * surfacing, since it's the only one where the AI's stored reasoning argues
 * against what the receipt now claims.
 */
function contradictsAi(receipt) {
  if (!receipt) return false;
  return (
    typeof receipt.taxDeductible === 'boolean' &&
    typeof receipt.aiTaxDeductible === 'boolean' &&
    receipt.taxDeductible !== receipt.aiTaxDeductible
  );
}

/**
 * The same rule as isDeductible(), expressed as a Prisma where-clause so the
 * database can filter on it. It has to be an OR because the effective value is
 * a coalesce across two columns, and Prisma can't express COALESCE in a
 * filter: a receipt is deductible when the customer said so, OR when they said
 * nothing and the AI said so.
 *
 * Kept next to isDeductible() on purpose -- a list filtered by one rule and
 * exported by a different one is the kind of drift nobody notices until a
 * customer's tax export disagrees with the screen they exported it from.
 *
 * @param {boolean} wantDeductible which side of the filter to return
 */
function deductibleWhereClause(wantDeductible) {
  return wantDeductible
    ? { OR: [{ taxDeductible: true }, { taxDeductible: null, aiTaxDeductible: true }] }
    : {
        OR: [
          { taxDeductible: false },
          { taxDeductible: null, aiTaxDeductible: false },
          // Never assessed -- isDeductible() reads these as not deductible, so
          // the "not deductible" list has to contain them or rows vanish from
          // both sides of the filter.
          { taxDeductible: null, aiTaxDeductible: null },
        ],
      };
}

module.exports = {
  isDeductible,
  deductibleSource,
  isCustomerDecided,
  contradictsAi,
  deductibleWhereClause,
};
