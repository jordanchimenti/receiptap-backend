// What counts as tax deductible, and who decided.
//
// Two columns on each receipt: aiTaxDeductible (what the model concluded) and
// taxDeductible (what the customer said, null until they say something). The
// customer always wins. The pair exists so a re-categorisation can't silently
// flip a receipt the customer already ruled on -- on their tax return.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  isDeductible,
  deductibleSource,
  isCustomerDecided,
  contradictsAi,
  deductibleWhereClause,
} = require('../lib/receiptDeductible');

test('the customer overrides the AI in both directions', () => {
  assert.strictEqual(isDeductible({ taxDeductible: false, aiTaxDeductible: true }), false);
  assert.strictEqual(isDeductible({ taxDeductible: true, aiTaxDeductible: false }), true);
});

test("the AI's call stands until the customer says otherwise", () => {
  assert.strictEqual(isDeductible({ taxDeductible: null, aiTaxDeductible: true }), true);
  assert.strictEqual(isDeductible({ taxDeductible: null, aiTaxDeductible: false }), false);
});

test('a receipt nobody has assessed is not claimed', () => {
  // Categorisation is best-effort and can fail. Claiming something nobody
  // assessed is the mistake with a cost attached, so silence means no.
  assert.strictEqual(isDeductible({}), false);
  assert.strictEqual(isDeductible({ taxDeductible: null, aiTaxDeductible: null }), false);
  assert.strictEqual(isDeductible(null), false);
});

test('source names who is currently speaking', () => {
  assert.strictEqual(deductibleSource({ taxDeductible: false, aiTaxDeductible: true }), 'customer');
  assert.strictEqual(deductibleSource({ aiTaxDeductible: true }), 'ai');
  assert.strictEqual(deductibleSource({}), 'none');
  // false is a decision, not an absence -- the bug a truthiness check makes.
  assert.strictEqual(deductibleSource({ taxDeductible: false }), 'customer');
  assert.ok(isCustomerDecided({ taxDeductible: false }));
});

test('a contradiction is only when both spoke and disagreed', () => {
  assert.ok(contradictsAi({ taxDeductible: false, aiTaxDeductible: true }));
  assert.ok(contradictsAi({ taxDeductible: true, aiTaxDeductible: false }));
  assert.ok(!contradictsAi({ taxDeductible: true, aiTaxDeductible: true }));
  assert.ok(!contradictsAi({ taxDeductible: true }));      // AI never ran
  assert.ok(!contradictsAi({ aiTaxDeductible: true }));    // customer silent
});

test('the where-clause and isDeductible agree on every combination', () => {
  // The list is filtered by the clause and exported by isDeductible. If they
  // ever disagree, a customer's tax export contradicts the screen they
  // exported it from -- so check all nine states against both.
  const states = [true, false, null];
  const matchesClause = (clause, receipt) =>
    clause.OR.some((cond) =>
      Object.entries(cond).every(([field, want]) => (receipt[field] ?? null) === want)
    );

  for (const taxDeductible of states) {
    for (const aiTaxDeductible of states) {
      const receipt = { taxDeductible, aiTaxDeductible };
      const expected = isDeductible(receipt);
      const label = `taxDeductible=${taxDeductible} aiTaxDeductible=${aiTaxDeductible}`;

      assert.strictEqual(matchesClause(deductibleWhereClause(true), receipt), expected,
        'deductible filter disagrees for ' + label);
      assert.strictEqual(matchesClause(deductibleWhereClause(false), receipt), !expected,
        'not-deductible filter disagrees for ' + label);
    }
  }
});
