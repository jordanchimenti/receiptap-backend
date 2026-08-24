// Whether a receipt is tax deductible, and who decided.
//
// The model does NOT decide it. Deductibility turns on who is filing, what the
// purchase was for, and the rules where they file -- none of which is on the
// receipt. The model says what was bought; the customer says which of their
// categories they can claim.
//
//   1. taxDeductible on the receipt   an answer about THIS receipt
//   2. its category is in the set     the customer's standing rule
//   3. otherwise                      not deductible

const { test } = require('node:test');
const assert = require('node:assert');

const {
  isDeductible,
  deductibleSource,
  isReceiptOverridden,
  overridesCategoryRule,
  deductibleWhereClause,
} = require('../lib/receiptDeductible');

const RULES = ['Office Supplies', 'Hardware & Tools'];

test('a category the customer chose makes its receipts deductible', () => {
  assert.ok(isDeductible({ aiCategory: 'Office Supplies', taxDeductible: null }, RULES));
  assert.strictEqual(deductibleSource({ aiCategory: 'Office Supplies' }, RULES), 'category');
});

test('a category they did not choose does not', () => {
  assert.ok(!isDeductible({ aiCategory: 'Entertainment', taxDeductible: null }, RULES));
  assert.strictEqual(deductibleSource({ aiCategory: 'Entertainment' }, RULES), 'none');
});

test('with no categories chosen, nothing is deductible by rule', () => {
  // The default. Nothing is claimable until the customer says it is.
  for (const empty of [[], null, undefined]) {
    assert.ok(!isDeductible({ aiCategory: 'Office Supplies', taxDeductible: null }, empty));
  }
});

test('a receipt-level answer beats the category rule, both ways', () => {
  // The laptop and the birthday gift bought at the same shop -- the case a
  // rule about categories can never get right on its own.
  assert.ok(isDeductible({ aiCategory: 'Entertainment', taxDeductible: true }, RULES));
  assert.ok(!isDeductible({ aiCategory: 'Office Supplies', taxDeductible: false }, RULES));
  assert.strictEqual(deductibleSource({ aiCategory: 'Office Supplies', taxDeductible: false }, RULES), 'receipt');
});

test('false is an answer, not an absence', () => {
  assert.ok(isReceiptOverridden({ taxDeductible: false }));
  assert.ok(!isReceiptOverridden({ taxDeductible: null }));
});

test('an override is only flagged when it changes the outcome', () => {
  // Ticking a receipt whose category is already deductible changes nothing,
  // and shouldn't be reported as disagreeing with the rule.
  assert.ok(!overridesCategoryRule({ aiCategory: 'Office Supplies', taxDeductible: true }, RULES));
  assert.ok(overridesCategoryRule({ aiCategory: 'Office Supplies', taxDeductible: false }, RULES));
  assert.ok(overridesCategoryRule({ aiCategory: 'Entertainment', taxDeductible: true }, RULES));
  assert.ok(!overridesCategoryRule({ aiCategory: 'Entertainment', taxDeductible: false }, RULES));
});

test('an uncategorised receipt is never deductible by rule', () => {
  // Categorisation is best-effort and can fail. Nothing to match on means no.
  assert.ok(!isDeductible({ aiCategory: null, taxDeductible: null }, RULES));
  assert.ok(isDeductible({ aiCategory: null, taxDeductible: true }, RULES));
});

test('the model no longer gets a vote', () => {
  // aiTaxDeductible is still a column on old rows. It must not sway anything.
  assert.ok(!isDeductible({ aiCategory: 'Entertainment', taxDeductible: null, aiTaxDeductible: true }, RULES));
  assert.ok(isDeductible({ aiCategory: 'Office Supplies', taxDeductible: null, aiTaxDeductible: false }, RULES));
});

test('the where-clause and isDeductible agree on every combination', () => {
  // The list is filtered by the clause and exported by isDeductible. If they
  // disagree, a tax export contradicts the screen it was exported from.
  const matches = (clause, receipt) =>
    clause.OR.some((cond) =>
      Object.entries(cond).every(([field, want]) => {
        const value = receipt[field] ?? null;
        if (want && typeof want === 'object' && 'in' in want) return want.in.includes(value);
        if (want && typeof want === 'object' && 'notIn' in want) {
          return value !== null && !want.notIn.includes(value);
        }
        return value === want;
      })
    );

  const categorySets = [[], RULES, ['Entertainment']];
  const overrides = [true, false, null];
  const cats = ['Office Supplies', 'Entertainment', null];

  for (const set of categorySets) {
    for (const taxDeductible of overrides) {
      for (const aiCategory of cats) {
        const receipt = { taxDeductible, aiCategory };
        const expected = isDeductible(receipt, set);
        const label = `set=[${set}] override=${taxDeductible} category=${aiCategory}`;

        assert.strictEqual(matches(deductibleWhereClause(true, set), receipt), expected,
          'deductible filter disagrees for ' + label);
        assert.strictEqual(matches(deductibleWhereClause(false, set), receipt), !expected,
          'not-deductible filter disagrees for ' + label);
      }
    }
  }
});
