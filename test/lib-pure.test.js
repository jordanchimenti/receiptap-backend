// Pure-function tests: no database, no network, no server. These cover the
// helpers where a silent wrong answer is expensive -- a hash that doesn't
// match, a barcode a scanner rejects, a referral credited to nobody.
const test = require('node:test');
const assert = require('node:assert/strict');

const { hashIdentifier } = require('../lib/hashIdentifier');
const { normalizeEmail } = require('../lib/normalizeEmail');
const { resolveBarcodeValue, normalizeBarcodeValue } = require('../lib/barcodeValue');
const { resolveTaxLabel, isCustomTaxLabel, TAX_LABEL_OPTIONS, CUSTOM_TAX_LABEL } = require('../lib/taxLabels');
const { readReferralCookie, isWithinWindow, REFERRAL_WINDOW_DAYS } = require('../lib/referralAttribution');

test('hashIdentifier never returns the raw value', () => {
  const h = hashIdentifier('sq_fingerprint_ABC');
  assert.equal(h.length, 64);
  assert.ok(!h.includes('sq_'));
});

test('hashIdentifier normalises case and whitespace to one hash', () => {
  assert.equal(hashIdentifier('sq_ABC'), hashIdentifier('  sq_abc  '));
});

test('hashIdentifier refuses junk rather than hashing it', () => {
  for (const v of [null, undefined, '', '   ', 42, {}]) assert.equal(hashIdentifier(v), null);
});

test('normalizeEmail makes lookups case-insensitive', () => {
  // The bug this exists for: a Google-created account is stored lowercase, so
  // logging in with the address capitalised the way a mail client shows it
  // used to miss the row entirely.
  assert.equal(normalizeEmail('  Jordan@GMail.com '), 'jordan@gmail.com');
  assert.equal(normalizeEmail(null), null);
});

test('barcode value resolves per source, and refuses to substitute', () => {
  const txn = { id: 'txn_1', orderNumber: 'A-1042' };
  const bare = { id: 'txn_1', orderNumber: null };
  assert.equal(resolveBarcodeValue({ barcodeValue: 'receiptNumber' }, txn), 'A-1042');
  assert.equal(resolveBarcodeValue({ barcodeValue: 'transactionId' }, txn), 'txn_1');
  assert.equal(resolveBarcodeValue({ barcodeValue: 'bestAvailable' }, bare), 'txn_1');
  assert.equal(resolveBarcodeValue({ barcodeValue: 'custom', barcodeCustomValue: 'S-99' }, txn), 'S-99');
  // A barcode that scans as the wrong order number is worse than none:
  assert.equal(resolveBarcodeValue({ barcodeValue: 'receiptNumber' }, bare), null);
  assert.equal(resolveBarcodeValue({ barcodeValue: 'custom', barcodeCustomValue: '  ' }, txn), null);
});

test('an unknown barcode source falls back rather than throwing', () => {
  assert.equal(normalizeBarcodeValue('nonsense'), 'receiptNumber');
});

test('tax label resolves presets and custom, never blank', () => {
  assert.equal(resolveTaxLabel('GST/HST', ''), 'GST/HST');
  assert.equal(resolveTaxLabel(CUSTOM_TAX_LABEL, 'TPS + TVQ'), 'TPS + TVQ');
  assert.equal(resolveTaxLabel(CUSTOM_TAX_LABEL, '   '), 'Tax'); // never an unlabelled tax line
  assert.equal(resolveTaxLabel('', ''), 'Tax');
});

test('tax label list has no duplicates and excludes impossible combinations', () => {
  assert.equal(new Set(TAX_LABEL_OPTIONS).size, TAX_LABEL_OPTIONS.length);
  // HST replaces GST+PST; no Canadian jurisdiction charges HST and PST together.
  assert.ok(!TAX_LABEL_OPTIONS.includes('GST/HST + PST'));
  for (const required of ['GST', 'HST', 'RST', 'QST', 'Sales Tax', 'GET', 'GRT', 'TPT']) {
    assert.ok(TAX_LABEL_OPTIONS.includes(required), `${required} missing`);
  }
});

test('a saved custom label reopens as custom, not as a broken preset', () => {
  assert.equal(isCustomTaxLabel('TVQ + TPS'), true);
  assert.equal(isCustomTaxLabel('GST'), false);
});

test('referral cookie is parsed out of a real cookie header', () => {
  assert.equal(readReferralCookie({ headers: { cookie: 'a=1; rt_ref=ABC123; b=2' } }), 'ABC123');
  assert.equal(readReferralCookie({ headers: { cookie: 'a=1' } }), null);
  assert.equal(readReferralCookie({ headers: {} }), null);
  assert.equal(readReferralCookie({}), null);
});

test('referral attribution expires at the stated window', () => {
  const days = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  assert.equal(REFERRAL_WINDOW_DAYS, 90);
  assert.equal(isWithinWindow(days(89)), true);
  assert.equal(isWithinWindow(days(91)), false);
  assert.equal(isWithinWindow(null), false);
});
