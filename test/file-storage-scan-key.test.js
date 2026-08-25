// test/file-storage-scan-key.test.js
// isValidScanKey() is the only thing standing between a hidden form field
// (round-tripped through the browser on the scan-review page, so untrusted)
// and a filesystem/Supabase read. A key with "../" in it must be rejected
// outright, not merely fail to resolve -- on the local-disk fallback path a
// passing "../" traverses out of private-uploads/ entirely.

const test = require('node:test');
const assert = require('node:assert');

const { buildKey, isValidScanKey } = require('../lib/fileStorage');

const CUSTOMER_ID = 'clxcustomer0000000000001';
const OTHER_CUSTOMER_ID = 'clxcustomer0000000000002';

test('accepts a key exactly as buildKey() actually produces one', () => {
  const key = buildKey('receipt-scans', 'photo.jpg', CUSTOMER_ID);
  assert.strictEqual(isValidScanKey(key, CUSTOMER_ID), true);
});

test('accepts a key buildKey() produces for a filename with no extension', () => {
  const key = buildKey('receipt-scans', 'photo', CUSTOMER_ID);
  assert.strictEqual(isValidScanKey(key, CUSTOMER_ID), true);
});

test('rejects directory-traversal keys outright', () => {
  const traversal = [
    'receipt-scans/../../../etc/passwd',
    `receipt-scans/${CUSTOMER_ID}-../../../etc/passwd`,
    `receipt-scans/${CUSTOMER_ID}-1700000000000-aaaaaaaaaaaa/../../secret.jpg`,
    `../receipt-scans/${CUSTOMER_ID}-1700000000000-aaaaaaaaaaaa.jpg`,
    // Begins exactly like a real key (would pass a startsWith() check) but
    // keeps going past what buildKey() would ever produce -- this is the
    // specific shape a startsWith()-only check would have let through.
    `receipt-scans/${CUSTOMER_ID}-1700000000000-aaaaaaaaaaaa.jpg/../../../secret`,
  ];
  for (const key of traversal) {
    assert.strictEqual(isValidScanKey(key, CUSTOMER_ID), false, `expected rejection for ${key}`);
  }
});

test('rejects a real key belonging to a different customer', () => {
  const key = buildKey('receipt-scans', 'photo.jpg', OTHER_CUSTOMER_ID);
  assert.strictEqual(isValidScanKey(key, CUSTOMER_ID), false);
});

test('rejects malformed or missing input without throwing', () => {
  for (const bad of [null, undefined, '', 'receipt-scans/', 42, {}, []]) {
    assert.strictEqual(isValidScanKey(bad, CUSTOMER_ID), false);
  }
  assert.strictEqual(isValidScanKey('receipt-scans/x-1700000000000-aaaaaaaaaaaa.jpg', ''), false);
  assert.strictEqual(isValidScanKey('receipt-scans/x-1700000000000-aaaaaaaaaaaa.jpg', null), false);
});

test('rejects the wrong folder and a hash of the wrong length', () => {
  assert.strictEqual(isValidScanKey(`logos/${CUSTOMER_ID}-1700000000000-aaaaaaaaaaaa.jpg`, CUSTOMER_ID), false);
  // 4 hex chars, not the 12 randomBytes(6).toString('hex') always produces.
  assert.strictEqual(isValidScanKey(`receipt-scans/${CUSTOMER_ID}-1700000000000-aaaa.jpg`, CUSTOMER_ID), false);
});
