// The My Rewards page filters on two axes at once: a Claim rewards /
// In progress / All tab, and a search box. A card shows only when BOTH agree,
// and getting that wrong in either direction is invisible until a customer
// swears a card has gone missing.
//
// The rule lives as one pure function inside the page's inline script. Rather
// than restate it here (which would let the copy drift from what ships), this
// extracts that exact source out of the template and runs it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const VIEW = path.join(__dirname, '..', 'views', 'account-loyalty.ejs');

function loadPredicate() {
  const src = fs.readFileSync(VIEW, 'utf8');
  const start = src.indexOf('function rewardCardMatches(');
  assert.notStrictEqual(start, -1, 'rewardCardMatches not found -- did the page stop using it?');
  const end = src.indexOf('\n    }', start);
  assert.notStrictEqual(end, -1, 'could not find the end of rewardCardMatches');
  const body = src.slice(start, end + '\n    }'.length);
  // eslint-disable-next-line no-new-func
  return new Function(body + '; return rewardCardMatches;')();
}

const matches = loadPredicate();

test('All shows both groups', () => {
  assert.ok(matches('ready', 'bean bar', 'all', ''));
  assert.ok(matches('progress', 'bean bar', 'all', ''));
});

test('Claim rewards shows only full cards', () => {
  assert.ok(matches('ready', 'bean bar', 'ready', ''));
  assert.ok(!matches('progress', 'bean bar', 'ready', ''));
});

test('In progress shows only cards still filling', () => {
  assert.ok(matches('progress', 'bean bar', 'progress', ''));
  assert.ok(!matches('ready', 'bean bar', 'progress', ''));
});

test('the tab and the search box both have to agree', () => {
  // Right group, wrong name.
  assert.ok(!matches('ready', 'bean bar', 'ready', 'coffee'));
  // Right name, wrong group -- the case that would leak a half-full card into
  // "Claim rewards" if the tab check were dropped once a query was present.
  assert.ok(!matches('progress', 'coffee house', 'ready', 'coffee'));
  // Both agree.
  assert.ok(matches('ready', 'coffee house', 'ready', 'coffee'));
});

test('search matches anywhere in the name, not just the start', () => {
  assert.ok(matches('ready', 'the coffee house', 'all', 'coffee'));
  assert.ok(matches('ready', 'the coffee house', 'all', 'house'));
  assert.ok(!matches('ready', 'the coffee house', 'all', 'tea'));
});

test('an empty query never hides anything its tab allows', () => {
  for (const q of ['', undefined, null]) {
    assert.ok(matches('ready', 'anything', 'all', q));
    assert.ok(matches('ready', 'anything', 'ready', q));
  }
});

test('a card with no merchant name is hidden by a query, not crashed on', () => {
  assert.ok(matches('ready', '', 'all', ''));
  assert.ok(!matches('ready', '', 'all', 'bean'));
  assert.doesNotThrow(() => matches('ready', undefined, 'all', 'bean'));
});
