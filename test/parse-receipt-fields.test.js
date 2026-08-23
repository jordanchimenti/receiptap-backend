// test/parse-receipt-fields.test.js
// These two functions are the difference between a receipt saving and the Save
// button appearing to do nothing: a NaN total used to reach Prisma, throw, and
// leave the request hanging with no response at all.

const test = require('node:test');
const assert = require('node:assert');

const { parseMoneyToCents, parseDateOrNull } = require('../lib/parseReceiptFields');

test('reads a plain amount as cents', () => {
  assert.strictEqual(parseMoneyToCents('12.34'), 1234);
  assert.strictEqual(parseMoneyToCents('7'), 700);
  assert.strictEqual(parseMoneyToCents(12.34), 1234);
});

test('tolerates how people and OCR actually write money', () => {
  assert.strictEqual(parseMoneyToCents('$12.34'), 1234);
  assert.strictEqual(parseMoneyToCents(' 12.34 '), 1234);
  assert.strictEqual(parseMoneyToCents('1,234.50'), 123450);
  assert.strictEqual(parseMoneyToCents('$1,234.50'), 123450);
  assert.strictEqual(parseMoneyToCents('12.34 CAD'), 1234);
});

test('rounds to whole cents rather than storing a fraction', () => {
  assert.strictEqual(parseMoneyToCents('12.345'), 1235);
  assert.strictEqual(parseMoneyToCents('0.015'), 2);
});

test('returns null instead of NaN for anything unreadable', () => {
  // Every one of these used to become NaN and hang the save request.
  for (const bad of ['abc', '', '   ', '$', null, undefined, {}, [], 'NaN']) {
    assert.strictEqual(parseMoneyToCents(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('rejects zero and negative totals', () => {
  assert.strictEqual(parseMoneyToCents('0'), null);
  assert.strictEqual(parseMoneyToCents('0.00'), null);
  assert.strictEqual(parseMoneyToCents('-5.00'), null);
});

test('an empty date is allowed and means no date', () => {
  assert.strictEqual(parseDateOrNull(''), null);
  assert.strictEqual(parseDateOrNull(null), null);
  assert.strictEqual(parseDateOrNull(undefined), null);
});

test('reads a real date, and refuses an unreadable one rather than throwing', () => {
  assert.strictEqual(parseDateOrNull('2026-08-01').toISOString().slice(0, 10), '2026-08-01');
  // An Invalid Date reaching Prisma throws exactly like NaN did.
  assert.strictEqual(parseDateOrNull('sometime'), null);
  assert.strictEqual(parseDateOrNull('not a date at all'), null);
});
