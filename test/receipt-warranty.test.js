// How long a purchase is covered, and who decided.
//
// The model estimates a typical warranty length from what was bought
// (aiWarrantyMonths). The customer's own number, if they give one, always
// wins (warrantyMonths) -- they know if they bought AppleCare, or that the
// guess was for the wrong item. 0 is an explicit "no warranty", not an
// absence of an answer.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  effectiveWarrantyMonths,
  computeWarrantyExpiry,
  warrantySource,
} = require('../lib/receiptWarranty');

test('the customer overrides the AI estimate', () => {
  assert.strictEqual(effectiveWarrantyMonths({ aiWarrantyMonths: 12, warrantyMonths: 24 }), 24);
  assert.strictEqual(warrantySource({ aiWarrantyMonths: 12, warrantyMonths: 24 }), 'customer');
});

test('0 from the customer means no warranty, not "no answer"', () => {
  assert.strictEqual(effectiveWarrantyMonths({ aiWarrantyMonths: 12, warrantyMonths: 0 }), 0);
  assert.strictEqual(warrantySource({ aiWarrantyMonths: 12, warrantyMonths: 0 }), 'customer');
  assert.strictEqual(computeWarrantyExpiry(new Date('2026-01-01'), 0), null);
});

test("the AI's estimate stands until the customer says otherwise", () => {
  assert.strictEqual(effectiveWarrantyMonths({ aiWarrantyMonths: 12, warrantyMonths: null }), 12);
  assert.strictEqual(warrantySource({ aiWarrantyMonths: 12, warrantyMonths: null }), 'ai');
});

test('nothing estimated and nothing said means no warranty tracked', () => {
  assert.strictEqual(effectiveWarrantyMonths({}), null);
  assert.strictEqual(effectiveWarrantyMonths(null), null);
  assert.strictEqual(warrantySource({}), 'none');
  assert.strictEqual(warrantySource(null), 'none');
});

test('computeWarrantyExpiry adds whole months to the purchase date', () => {
  assert.deepStrictEqual(computeWarrantyExpiry(new Date('2026-01-15'), 12), new Date('2027-01-15'));
  assert.deepStrictEqual(computeWarrantyExpiry(new Date('2026-01-15'), 3), new Date('2026-04-15'));
});

test('computeWarrantyExpiry is null with no purchase date, no months, or a non-positive count', () => {
  assert.strictEqual(computeWarrantyExpiry(null, 12), null);
  assert.strictEqual(computeWarrantyExpiry(new Date('2026-01-01'), null), null);
  assert.strictEqual(computeWarrantyExpiry(new Date('2026-01-01'), -1), null);
});

test('categorization time and override time agree on the same receipt', () => {
  // Both call sites (services/categorize-receipt.js and the override route in
  // routes/customer-account.js) go through computeWarrantyExpiry -- this is
  // the check that they can never quietly disagree.
  const purchaseDate = new Date('2026-06-01');
  const aiEstimate = computeWarrantyExpiry(purchaseDate, effectiveWarrantyMonths({ aiWarrantyMonths: 12, warrantyMonths: null }));
  const customerCorrection = computeWarrantyExpiry(purchaseDate, effectiveWarrantyMonths({ aiWarrantyMonths: 12, warrantyMonths: 24 }));
  assert.deepStrictEqual(aiEstimate, new Date('2027-06-01'));
  assert.deepStrictEqual(customerCorrection, new Date('2028-06-01'));
});
