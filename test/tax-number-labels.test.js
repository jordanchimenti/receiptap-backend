// The Tax type fields in wallet settings are dropdowns, so what the form
// submits is either a preset, a blank, or the "Custom…" sentinel paired with
// a free-text box. resolveTaxNumberLabel is what keeps the sentinel from
// reaching the database and printing "__custom__" on every receipt.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  TAX_NUMBER_LABEL_OPTIONS,
  TAX_LABEL_OPTIONS,
  CUSTOM_TAX_LABEL,
  isCustomTaxNumberLabel,
  resolveTaxNumberLabel,
} = require('../lib/taxLabels');

test('a preset is stored exactly as offered', () => {
  for (const opt of ['GST/HST', 'QST', 'PST', 'VAT']) {
    assert.ok(TAX_NUMBER_LABEL_OPTIONS.includes(opt), opt + ' should be offered');
    assert.strictEqual(resolveTaxNumberLabel(opt, ''), opt);
  }
});

test('the custom sentinel never reaches storage', () => {
  assert.strictEqual(resolveTaxNumberLabel(CUSTOM_TAX_LABEL, '  TPS + TVQ  '), 'TPS + TVQ');
  // Custom picked, nothing typed -> blank, not the sentinel. The receipt
  // layouts fall back on their own ('GST/HST' first, 'Tax' second).
  assert.strictEqual(resolveTaxNumberLabel(CUSTOM_TAX_LABEL, ''), '');
  assert.strictEqual(resolveTaxNumberLabel(CUSTOM_TAX_LABEL, '   '), '');
});

test('blank stays blank rather than acquiring a default', () => {
  assert.strictEqual(resolveTaxNumberLabel('', ''), '');
  assert.strictEqual(resolveTaxNumberLabel(undefined, undefined), '');
});

test('a label that is not a preset is treated as custom on the way back out', () => {
  assert.ok(isCustomTaxNumberLabel('Parish Tax'));
  assert.ok(!isCustomTaxNumberLabel('GST/HST'));
  // Blank is absence, not a custom value -- it must not open the Custom box.
  assert.ok(!isCustomTaxNumberLabel(''));
});

test('registration labels are a narrower list than tax-line labels', () => {
  // The tax LINE list names charges ("Meals Tax"); a registration list must
  // not, or the dropdown offers types that have no number to print.
  assert.ok(TAX_LABEL_OPTIONS.includes('Meals Tax'));
  assert.ok(!TAX_NUMBER_LABEL_OPTIONS.includes('Meals Tax'));
  assert.ok(!TAX_NUMBER_LABEL_OPTIONS.includes('Occupancy Tax'));
  // The ones CRA compliance actually turns on must be present.
  assert.ok(TAX_NUMBER_LABEL_OPTIONS.includes('GST/HST'));
  assert.ok(TAX_NUMBER_LABEL_OPTIONS.includes('QST'));
});

test('every offered option survives a round trip', () => {
  for (const opt of TAX_NUMBER_LABEL_OPTIONS) {
    assert.strictEqual(resolveTaxNumberLabel(opt, ''), opt);
    assert.ok(!isCustomTaxNumberLabel(opt), opt + ' should not read as custom');
    assert.ok(opt.length <= 20, opt + ' must fit the 20-char column');
  }
});
