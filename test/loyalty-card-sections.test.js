// Full cards are the only ones the customer can act on. In a single list
// ordered by most-recently-stamped they sink below barely-started cards, so
// the reward they already earned is the hardest one to find.

const { test } = require('node:test');
const assert = require('node:assert');

const { splitLoyaltyCards, isCardFull } = require('../lib/loyaltyCardSections');

const card = (stamps, stampsRequired, id) => ({ id, stamps, stampsRequired });

test('full cards go to ready, partial ones to in-progress', () => {
  const { ready, inProgress } = splitLoyaltyCards([
    card(1, 5, 'a'),
    card(5, 5, 'b'),
    card(0, 10, 'c'),
    card(10, 10, 'd'),
  ]);
  assert.deepStrictEqual(ready.map((c) => c.id), ['b', 'd']);
  assert.deepStrictEqual(inProgress.map((c) => c.id), ['a', 'c']);
});

test('order within each section is preserved', () => {
  // The route sorts by updatedAt desc; splitting must not reshuffle that, or
  // the most recently used card stops leading its section.
  const { ready, inProgress } = splitLoyaltyCards([
    card(3, 3, 'newest-full'),
    card(1, 3, 'newest-partial'),
    card(3, 3, 'older-full'),
    card(2, 3, 'older-partial'),
  ]);
  assert.deepStrictEqual(ready.map((c) => c.id), ['newest-full', 'older-full']);
  assert.deepStrictEqual(inProgress.map((c) => c.id), ['newest-partial', 'older-partial']);
});

test('a card over its target still counts as ready', () => {
  // Lowering stampsRequired after cards were stamped leaves cards holding more
  // than the target. Those are redeemable -- POST /loyalty/:cardId/redeem uses
  // the same >= test, so the button must not appear in the wrong section.
  assert.ok(isCardFull(card(7, 5)));
  const { ready } = splitLoyaltyCards([card(7, 5, 'over')]);
  assert.deepStrictEqual(ready.map((c) => c.id), ['over']);
});

test('a zero-stamp target does not mark every card full', () => {
  assert.ok(!isCardFull(card(0, 0)));
  const { ready, inProgress } = splitLoyaltyCards([card(0, 0, 'z')]);
  assert.strictEqual(ready.length, 0);
  assert.deepStrictEqual(inProgress.map((c) => c.id), ['z']);
});

test('missing or malformed numbers are treated as not full', () => {
  assert.ok(!isCardFull({}));
  assert.ok(!isCardFull(null));
  assert.ok(!isCardFull({ stamps: 'x', stampsRequired: 5 }));
});

test('an empty or absent list yields two empty sections', () => {
  for (const input of [[], null, undefined]) {
    const { ready, inProgress } = splitLoyaltyCards(input);
    assert.deepStrictEqual(ready, []);
    assert.deepStrictEqual(inProgress, []);
  }
});
