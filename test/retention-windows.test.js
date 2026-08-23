// test/retention-windows.test.js
// The retention window is a compliance guarantee, not a preference. It was
// 24 months, which silently destroyed receipts years before the tax
// authorities stop expecting people to have them -- in a product whose whole
// promise is "your receipts are here at tax time". These assertions exist so
// that number can't drift back down without someone deliberately rewriting
// the reason it's there.

const test = require('node:test');
const assert = require('node:assert');

const {
  SHOPPER_RECEIPT_MONTHS,
  SHOPPER_ACCOUNT_MONTHS,
  LEGAL_ACCEPTANCE_RETENTION_MONTHS,
  EMAIL_SUPPRESSION_RETENTION_MONTHS,
} = require('../config/retention');

// CRA: business records must be kept six years from the END of the tax year
// they relate to. A receipt dated in January belongs to a year that ends
// eleven months later, so six-years-from-year-end is nearly seven from the
// receipt's own date -- which is what the window has to cover.
const CRA_YEARS_FROM_YEAR_END = 6;
const CRA_MINIMUM_MONTHS = (CRA_YEARS_FROM_YEAR_END + 1) * 12;

test('receipts outlive the CRA six-year record-keeping requirement', () => {
  assert.ok(
    SHOPPER_RECEIPT_MONTHS >= CRA_MINIMUM_MONTHS,
    `receipts are purged after ${SHOPPER_RECEIPT_MONTHS} months, which is inside ` +
      `the ${CRA_MINIMUM_MONTHS} a January receipt needs to satisfy CRA's six ` +
      `years from the end of its tax year`
  );
});

test('receipts outlive the longest ordinary US limitation period', () => {
  // Three years normally, six where more than 25% of income was omitted,
  // seven for a bad-debt or worthless-securities claim.
  assert.ok(SHOPPER_RECEIPT_MONTHS >= 7 * 12);
});

test('an account outlives the receipts attached to it', () => {
  // The account is what a shopper logs into to reach those receipts. Purging
  // it first would leave them technically retained and practically gone.
  assert.ok(SHOPPER_ACCOUNT_MONTHS >= SHOPPER_RECEIPT_MONTHS);
});

test('the two deliberate never-purge records still never purge', () => {
  // Both are load-bearing: LegalAcceptance proves who agreed to what and
  // when, and EmailSuppression stops a deleted shopper being re-enrolled in
  // marketing by a future receipt claim.
  assert.strictEqual(LEGAL_ACCEPTANCE_RETENTION_MONTHS, Infinity);
  assert.strictEqual(EMAIL_SUPPRESSION_RETENTION_MONTHS, Infinity);
});
