// The wallet export interpolated business names straight into each CSV line,
// so a merchant called "Bob, Inc." shifted every later column by one for that
// row -- in a tax export the total lands in the category column.

const { test } = require('node:test');
const assert = require('node:assert');
const { csvCell } = require('../lib/csvCell');

test('plain values are left alone', () => {
  assert.strictEqual(csvCell('Tip Top Tint'), 'Tip Top Tint');
  assert.strictEqual(csvCell('12.50'), '12.50');
});

test('a comma no longer splits the row', () => {
  assert.strictEqual(csvCell('Bob, Inc.'), '"Bob, Inc."');
});

test('quotes are doubled, per RFC 4180', () => {
  assert.strictEqual(csvCell('He said "hi"'), '"He said ""hi"""');
  assert.strictEqual(csvCell('"'), '""""');
});

test('newlines are contained rather than ending the record', () => {
  assert.strictEqual(csvCell('Line one\nLine two'), '"Line one\nLine two"');
  assert.strictEqual(csvCell('carriage\rreturn'), '"carriage\rreturn"');
});

test('null and undefined become an empty cell, not the text "null"', () => {
  assert.strictEqual(csvCell(null), '');
  assert.strictEqual(csvCell(undefined), '');
});

test('non-strings are stringified', () => {
  assert.strictEqual(csvCell(0), '0');
  assert.strictEqual(csvCell(false), 'false');
});
