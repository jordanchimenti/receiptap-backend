// lib/receiptDeductible.js
//
// Whether a receipt counts as tax deductible, and who decided.
//
// WHAT THE AI DOES NOT DECIDE
//
// An earlier version let the model answer this directly (Transaction.
// aiTaxDeductible, still stored, no longer consulted). It couldn't: whether a
// purchase is deductible depends on who is filing -- self-employed or
// employed, what the thing was actually for, and the rules of the place they
// file in. None of that is on the receipt. The same coffee is deductible for
// one person and not for the person behind them in the queue. The old prompt
// hedged with "be moderate, not aggressive", which is the tell: a guess, and
// it was driving the wallet filter and the tax export.
//
// So the model does the part it can do -- read the receipt and categorise it
// -- and the customer says which of THEIR categories are deductible, which is
// a claim about their own affairs that only they can make.
//
// THE ORDER, most specific first
//
//   1. taxDeductible on the receipt   an explicit answer about THIS receipt
//   2. its category is in the set     the customer's standing rule
//   3. otherwise                      not deductible
//
// Step 1 exists because a rule about categories can't tell a laptop from a
// birthday gift bought at the same shop. Step 3 is deliberate: claiming
// something nobody has ruled on is the mistake with a cost attached.

/**
 * @param {object} receipt              needs `taxDeductible` and `aiCategory`
 * @param {string[]} deductibleCategories the customer's chosen categories
 * @returns {boolean}
 */
function isDeductible(receipt, deductibleCategories = []) {
  if (!receipt) return false;
  if (typeof receipt.taxDeductible === 'boolean') return receipt.taxDeductible;
  if (!receipt.aiCategory) return false;
  return toSet(deductibleCategories).has(receipt.aiCategory);
}

/** @returns {'receipt'|'category'|'none'} what the current answer rests on. */
function deductibleSource(receipt, deductibleCategories = []) {
  if (!receipt) return 'none';
  if (typeof receipt.taxDeductible === 'boolean') return 'receipt';
  if (receipt.aiCategory && toSet(deductibleCategories).has(receipt.aiCategory)) return 'category';
  return 'none';
}

/** True once the customer has ruled on this specific receipt, either way. */
function isReceiptOverridden(receipt) {
  return Boolean(receipt) && typeof receipt.taxDeductible === 'boolean';
}

/**
 * True when a per-receipt answer disagrees with what the category rule would
 * have said -- the only case where the two mechanisms visibly differ, and so
 * the only one worth explaining in the UI.
 */
function overridesCategoryRule(receipt, deductibleCategories = []) {
  if (!isReceiptOverridden(receipt)) return false;
  const byCategory = Boolean(receipt.aiCategory) && toSet(deductibleCategories).has(receipt.aiCategory);
  return receipt.taxDeductible !== byCategory;
}

/**
 * The same rule as a Prisma where-clause, so the database can filter on it.
 * An OR because the effective value is a fallback chain and Prisma can't
 * express one in a filter.
 *
 * Kept beside isDeductible() on purpose: a list filtered by one rule and
 * exported by another is how a tax export ends up disagreeing with the screen
 * it was exported from.
 */
function deductibleWhereClause(wantDeductible, deductibleCategories = []) {
  const categories = [...toSet(deductibleCategories)];

  if (wantDeductible) {
    const clauses = [{ taxDeductible: true }];
    // With no categories chosen, the only deductible receipts are ones the
    // customer ticked by hand -- so this half must not be added, or `in: []`
    // would quietly match nothing AND drag the whole OR down with it.
    if (categories.length) {
      clauses.push({ taxDeductible: null, aiCategory: { in: categories } });
    }
    return { OR: clauses };
  }

  return {
    OR: [
      { taxDeductible: false },
      categories.length
        ? { taxDeductible: null, aiCategory: { notIn: categories } }
        : { taxDeductible: null },
      // notIn never matches a null column, so uncategorised receipts need
      // saying explicitly or they'd vanish from both sides of the filter.
      { taxDeductible: null, aiCategory: null },
    ],
  };
}

function toSet(categories) {
  return new Set(Array.isArray(categories) ? categories.filter(Boolean) : []);
}

module.exports = {
  isDeductible,
  deductibleSource,
  isReceiptOverridden,
  overridesCategoryRule,
  deductibleWhereClause,
};
