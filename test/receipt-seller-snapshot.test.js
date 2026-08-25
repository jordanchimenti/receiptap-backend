// test/receipt-seller-snapshot.test.js
// The whole point of the receipt_seller_snapshot migration: a receipt keeps
// stating what was true about the merchant on its own sale date, even after
// the merchant later edits Business Settings or Theme Settings. Before this
// migration, routes/receipt.js live-joined Merchant/ReceiptTheme on every
// render, so an edited GST/HST number or business name silently rewrote
// every past receipt. These tests are the guarantee that a stale-looking
// live join can never quietly come back -- both the "old receipt didn't
// change" and "new receipt DID pick up the change" halves, since a fix that
// only checked one side could still regress the other.

const test = require('node:test');
const assert = require('node:assert');

const { buildSellerSnapshot, resolveSellerForRender } = require('../lib/receiptSnapshot');

const ORIGINAL_MERCHANT = {
  businessName: 'Original Coffee Co.',
  addressLine1: '1 First St.',
  addressLine2: null,
  addressCity: 'Niagara Falls',
  addressRegion: 'ON',
  addressPostalCode: 'L2E 0A1',
  addressCountry: 'CA',
};
const ORIGINAL_THEME = {
  displayName: null,
  gstHstNumber: '123456789 RT0001',
  taxNumberLabel: null,
  taxNumber2: null,
  taxNumber2Label: null,
  taxLabel: 'Tax',
};

const CHANGED_MERCHANT = {
  ...ORIGINAL_MERCHANT,
  businessName: 'Renamed Coffee Corp.',
};
const CHANGED_THEME = {
  ...ORIGINAL_THEME,
  gstHstNumber: '999999999 RT0001',
};

test('a transaction snapshotted at the original values keeps showing them after the merchant edits their profile', () => {
  // "Create a transaction" -- buildSellerSnapshot is exactly what every POS
  // webhook handler calls at Transaction.create() time.
  const snapshot = buildSellerSnapshot({ ...ORIGINAL_MERCHANT, receiptTheme: ORIGINAL_THEME });
  const transaction = { id: 'txn_1', ...snapshot };

  // "Change the merchant's businessName and gstHstNumber" -- re-render
  // against the CHANGED merchant/theme, the way a real render would after
  // a Business Settings save.
  const seller = resolveSellerForRender(transaction, { theme: CHANGED_THEME, merchant: CHANGED_MERCHANT });

  assert.strictEqual(seller.name, 'Original Coffee Co.');
  assert.strictEqual(seller.gstHstNumber, '123456789 RT0001');
});

test('a transaction created after the change picks up the new values', () => {
  const snapshot = buildSellerSnapshot({ ...CHANGED_MERCHANT, receiptTheme: CHANGED_THEME });
  const transaction = { id: 'txn_2', ...snapshot };

  const seller = resolveSellerForRender(transaction, { theme: CHANGED_THEME, merchant: CHANGED_MERCHANT });

  assert.strictEqual(seller.name, 'Renamed Coffee Corp.');
  assert.strictEqual(seller.gstHstNumber, '999999999 RT0001');
});

test('a ReceiptTheme displayName overrides businessName in the snapshot, but legalName keeps the real one', () => {
  const snapshot = buildSellerSnapshot({
    ...ORIGINAL_MERCHANT,
    receiptTheme: { ...ORIGINAL_THEME, displayName: 'Original Coffee (DBA)' },
  });
  assert.strictEqual(snapshot.sellerName, 'Original Coffee (DBA)');
  assert.strictEqual(snapshot.sellerLegalName, 'Original Coffee Co.');
});

test('no ReceiptTheme row yet falls back to the documented defaults, not an error', () => {
  // A merchant who's connected a POS but never opened Business/Theme
  // Settings -- receiptTheme is null, not undefined, once the caller used
  // `include: { receiptTheme: true }`.
  const snapshot = buildSellerSnapshot({ ...ORIGINAL_MERCHANT, receiptTheme: null });
  assert.strictEqual(snapshot.sellerName, 'Original Coffee Co.');
  assert.strictEqual(snapshot.sellerGstHstNumber, null);
  assert.strictEqual(snapshot.sellerTaxLabel, 'Tax');
});

test('buildSellerSnapshot throws if the caller forgot to include receiptTheme', () => {
  // receiptTheme is undefined here (key never set), simulating a query that
  // omitted `include: { receiptTheme: true }` -- must fail loudly, not
  // silently produce the same all-null shape as a genuine no-theme merchant.
  assert.throws(() => buildSellerSnapshot({ ...ORIGINAL_MERCHANT }), /include: \{ receiptTheme: true \}/);
});

test('resolveSellerForRender throws on a real (non-synthetic) transaction missing its snapshot', () => {
  const transactionMissingSnapshot = { id: 'txn_legacy' }; // e.g. a `select` that omitted sellerName
  assert.throws(
    () => resolveSellerForRender(transactionMissingSnapshot, { theme: ORIGINAL_THEME, merchant: ORIGINAL_MERCHANT }),
    /missing its seller snapshot/
  );
});

test('resolveSellerForRender does not throw for a synthetic transaction, and reads the live theme/merchant', () => {
  const seller = resolveSellerForRender(
    { id: 'preview' }, // no seller* fields at all -- fine, isSynthetic skips reading transaction entirely
    { theme: { ...ORIGINAL_THEME, displayName: 'Preview Name' }, merchant: ORIGINAL_MERCHANT, isSynthetic: true }
  );
  assert.strictEqual(seller.name, 'Preview Name');
  assert.strictEqual(seller.gstHstNumber, '123456789 RT0001');
});
