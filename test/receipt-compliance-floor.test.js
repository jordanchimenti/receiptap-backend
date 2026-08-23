// test/receipt-compliance-floor.test.js
// Receipt design is a wall of switches, and six of them used to turn off
// things a receipt legally can't do without. Two separate causes were seen
// switching them off without anyone choosing to -- a merchant flipping them by
// hand, and a save from a page that doesn't render them at all. These tests
// are the guarantee that whatever ends up in the database, the receipt that
// reaches a customer still carries what their claim depends on.

const test = require('node:test');
const assert = require('node:assert');

const { applyComplianceFloor, ITEM_DETAIL_REQUIRED_FROM_CENTS } = require('../lib/receiptComplianceFloor');

// The worst case: a merchant who switched off everything they could.
const ALL_OFF = {
  showBusinessName: false, showDateTime: false, showTax: false, showTotal: false,
  showTaxNumber: false, showItemQuantity: false, showItemUnitPrice: false, showItemLineTotal: false,
};

test('the seller, the date and the total are printed whatever the theme says', () => {
  const t = applyComplianceFloor(ALL_OFF, { total: 2032, tax: 234 });
  assert.strictEqual(t.showBusinessName, true);
  assert.strictEqual(t.showDateTime, true);
  assert.strictEqual(t.showTotal, true);
});

test('the tax registration number is printed whatever the theme says', () => {
  // Safe even for a merchant who has no number: the layouts also check
  // gstHstNumber is actually set before printing a line for it.
  const t = applyComplianceFloor(ALL_OFF, { total: 2032, tax: 234 });
  assert.strictEqual(t.showTaxNumber, true);
});

test('tax is forced on when tax was charged', () => {
  const t = applyComplianceFloor(ALL_OFF, { total: 2032, tax: 234 });
  assert.strictEqual(t.showTax, true);
});

test('tax stays hidden when none was charged, if that is what they chose', () => {
  // Nothing to substantiate, so a "$0.00" line is noise rather than evidence
  // -- the one case where the merchant's own preference still stands.
  const t = applyComplianceFloor(ALL_OFF, { total: 1000, tax: 0 });
  assert.strictEqual(t.showTax, false);
});

test('line detail is left to the merchant below the CRA threshold', () => {
  // A pharmacy or a clinic has a real reason not to itemise into a wallet,
  // and under $150 no rule says they must.
  const t = applyComplianceFloor(ALL_OFF, { total: ITEM_DETAIL_REQUIRED_FROM_CENTS - 1, tax: 500 });
  assert.strictEqual(t.showItemQuantity, false);
  assert.strictEqual(t.showItemUnitPrice, false);
  assert.strictEqual(t.showItemLineTotal, false);
});

test('line detail is forced from $150 up, where CRA requires it', () => {
  const t = applyComplianceFloor(ALL_OFF, { total: ITEM_DETAIL_REQUIRED_FROM_CENTS, tax: 1950 });
  assert.strictEqual(t.showItemQuantity, true);
  assert.strictEqual(t.showItemUnitPrice, true);
  assert.strictEqual(t.showItemLineTotal, true);
});

test('the threshold is inclusive -- exactly $150 already requires detail', () => {
  assert.strictEqual(ITEM_DETAIL_REQUIRED_FROM_CENTS, 15000);
  const at = applyComplianceFloor(ALL_OFF, { total: 15000, tax: 0 });
  const below = applyComplianceFloor(ALL_OFF, { total: 14999, tax: 0 });
  assert.strictEqual(at.showItemLineTotal, true);
  assert.strictEqual(below.showItemLineTotal, false);
});

test('everything the merchant is still free to choose is left alone', () => {
  const theme = { ...ALL_OFF, showLogo: false, showPhone: false, showBarcode: true, showPromo: true, layoutId: 'minimal' };
  const t = applyComplianceFloor(theme, { total: 2032, tax: 234 });
  assert.strictEqual(t.showLogo, false);
  assert.strictEqual(t.showPhone, false);
  assert.strictEqual(t.showBarcode, true);
  assert.strictEqual(t.showPromo, true);
  assert.strictEqual(t.layoutId, 'minimal');
});

test('the caller\'s theme object is not mutated', () => {
  // The same theme is reused across a request; forcing a flag here must not
  // silently rewrite what a later save then persists.
  const theme = { ...ALL_OFF };
  applyComplianceFloor(theme, { total: 2032, tax: 234 });
  assert.strictEqual(theme.showTotal, false);
});

test('a missing or unreadable transaction still gets the unconditional floor', () => {
  const t = applyComplianceFloor(ALL_OFF, {});
  assert.strictEqual(t.showBusinessName, true);
  assert.strictEqual(t.showTotal, true);
  // Nothing knowable about tax or size, so the conditional rules stay off.
  assert.strictEqual(t.showTax, false);
  assert.strictEqual(t.showItemLineTotal, false);
});
