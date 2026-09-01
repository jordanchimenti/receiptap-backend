// test/receipt-missing-fields.test.js
// Shared between the individual scanned-receipt page and the bulk tax
// export (see lib/receiptMissingFields.js) -- if this drifted, the two
// could show a receipt as complete in one place and incomplete in the
// other, which is exactly the kind of thing an audit would catch and a
// customer wouldn't.

const test = require('node:test');
const assert = require('node:assert');

const { missingSubstantiationFields } = require('../lib/receiptMissingFields');

test('a fully-detailed scanned receipt is missing nothing', () => {
  const receipt = {
    taxNumber: 'GST 123456789RT0001',
    receiptNumber: 'R-001',
    paymentMethod: 'Visa ••••1234',
    purchaseTimeText: '2:15 PM',
    buyerName: 'Jordan C.',
    total: 20000,
  };
  assert.deepStrictEqual(missingSubstantiationFields('scanned', receipt), []);
});

test('a bare-minimum scanned receipt under $500 flags everything but the buyer name', () => {
  const receipt = {
    taxNumber: null, receiptNumber: null, paymentMethod: null, purchaseTimeText: null,
    buyerName: null, total: 4599,
  };
  assert.deepStrictEqual(missingSubstantiationFields('scanned', receipt), [
    'a tax registration number',
    'a receipt number',
    'how it was paid',
    'the time of day',
  ]);
});

test('the buyer-name check only fires at or above $500 (50000 cents)', () => {
  const under = { taxNumber: 'x', receiptNumber: 'x', paymentMethod: 'x', purchaseTimeText: 'x', buyerName: null, total: 49999 };
  const atThreshold = { ...under, total: 50000 };
  assert.deepStrictEqual(missingSubstantiationFields('scanned', under), []);
  assert.deepStrictEqual(missingSubstantiationFields('scanned', atThreshold), ["the buyer's name (CRA asks for it over $500)"]);
});

test('a tapped receipt is never flagged for missing time or a receipt number', () => {
  // Transaction.createdAt is a real webhook timestamp, and Transaction.id
  // is itself the POS's own transaction id -- neither can be "missing" the
  // way a photographed receipt's printed text can be.
  const transaction = { sellerGstHstNumber: null, paymentMethod: null };
  const missing = missingSubstantiationFields('tapped', transaction);
  assert.ok(!missing.some((m) => m.includes('time')));
  assert.ok(!missing.some((m) => m.includes('receipt number')));
});

test('a tapped receipt checks its own tax-number and payment-method fields', () => {
  assert.deepStrictEqual(
    missingSubstantiationFields('tapped', { sellerGstHstNumber: null, paymentMethod: null }),
    ['a tax registration number', 'how it was paid']
  );
  assert.deepStrictEqual(
    missingSubstantiationFields('tapped', { sellerGstHstNumber: '123456789RT0001', paymentMethod: 'Visa' }),
    []
  );
});

test('a tapped receipt over $500 with no buyer name is flagged, same as a scanned one', () => {
  const transaction = { sellerGstHstNumber: 'x', paymentMethod: 'x', buyerName: null, total: 999999 };
  assert.deepStrictEqual(missingSubstantiationFields('tapped', transaction), [
    "the buyer's name (CRA asks for it over $500)",
  ]);
});

test('a tapped receipt with a buyer name on file is not flagged, regardless of amount', () => {
  const transaction = { sellerGstHstNumber: 'x', paymentMethod: 'x', buyerName: 'Jordan C.', total: 999999 };
  assert.deepStrictEqual(missingSubstantiationFields('tapped', transaction), []);
});

test('a tapped receipt under $500 is not flagged for a missing buyer name', () => {
  const transaction = { sellerGstHstNumber: 'x', paymentMethod: 'x', buyerName: null, total: 49999 };
  assert.deepStrictEqual(missingSubstantiationFields('tapped', transaction), []);
});
