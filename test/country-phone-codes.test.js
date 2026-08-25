// test/country-phone-codes.test.js
// The dataset behind every phone-number input's country dropdown (see
// views/partials/phone-input.ejs). No hand-typed flag emoji to verify --
// they're derived from the ISO code -- but the underlying data still needs
// to be internally consistent, since a duplicate or malformed entry would
// silently corrupt a <select> built from it.

const test = require('node:test');
const assert = require('node:assert');

const { COUNTRIES, flagEmoji, findByIso2 } = require('../lib/countryPhoneCodes');

test('every country has a well-formed ISO2 code, name, and numeric dial code', () => {
  for (const c of COUNTRIES) {
    assert.match(c.iso2, /^[A-Z]{2}$/, `bad iso2 for ${c.name}`);
    assert.ok(c.name && c.name.length > 0, `missing name for ${c.iso2}`);
    assert.match(c.dialCode, /^\d+$/, `bad dialCode for ${c.name}`);
  }
});

test('no ISO2 code appears twice', () => {
  const codes = COUNTRIES.map((c) => c.iso2);
  const seen = new Set();
  const dupes = codes.filter((code) => (seen.has(code) ? true : (seen.add(code), false)));
  assert.deepStrictEqual(dupes, []);
});

test('Canada and United States are present and lead the list', () => {
  assert.strictEqual(COUNTRIES[0].iso2, 'CA');
  assert.strictEqual(COUNTRIES[1].iso2, 'US');
  assert.strictEqual(COUNTRIES[0].dialCode, '1');
  assert.strictEqual(COUNTRIES[1].dialCode, '1');
});

test('flagEmoji derives the correct regional-indicator pair', () => {
  // U+1F1E8 U+1F1E6 = regional indicators C, A
  assert.strictEqual(flagEmoji('CA'), '\u{1F1E8}\u{1F1E6}');
  assert.strictEqual(flagEmoji('US'), '\u{1F1FA}\u{1F1F8}');
  // Lowercase input still produces the right flag -- callers shouldn't have
  // to normalize case themselves before this.
  assert.strictEqual(flagEmoji('gb'), flagEmoji('GB'));
});

test('every country in the list produces a two-codepoint flag with no errors', () => {
  for (const c of COUNTRIES) {
    const flag = flagEmoji(c.iso2);
    assert.strictEqual([...flag].length, 2, `flag for ${c.name} (${c.iso2}) is not two codepoints`);
  }
});

test('findByIso2 is case-insensitive and returns null for an unknown code', () => {
  assert.strictEqual(findByIso2('ca').iso2, 'CA');
  assert.strictEqual(findByIso2('CA').iso2, 'CA');
  assert.strictEqual(findByIso2('zz'), null);
  assert.strictEqual(findByIso2(''), null);
  assert.strictEqual(findByIso2(undefined), null);
});
