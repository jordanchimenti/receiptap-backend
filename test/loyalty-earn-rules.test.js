// test/loyalty-earn-rules.test.js
// stampsEarnedFor() decides how much one receipt is worth, and it's the only
// part of the stamp card a merchant can get wrong in four different ways --
// so it's pure, and tested here without a database.

const test = require('node:test');
const assert = require('node:assert');

const { stampsEarnedFor } = require('../routes/loyalty');

const program = (over) => ({ earnRule: 'ORDER', earnItemName: null, earnAmountCents: 1000, ...over });
const receipt = (over) => ({ total: 2700, lineItems: [], ...over });

test('ORDER gives one stamp per receipt, whatever is on it', () => {
  assert.strictEqual(stampsEarnedFor(program(), receipt(), null), 1);
  assert.strictEqual(stampsEarnedFor(program(), receipt({ total: 100000 }), { stamps: 3, lastStampedAt: null }), 1);
});

test('an unrecognised rule falls back to one per order rather than zero', () => {
  assert.strictEqual(stampsEarnedFor(program({ earnRule: 'NONSENSE' }), receipt(), null), 1);
});

test('VISIT gives the first stamp of the day and nothing after it', () => {
  // Anchored to the current UTC DAY, not to "an hour ago". The first version
  // of this test used now-minus-one-hour to mean "earlier today", which stops
  // being true for the hour after UTC midnight -- it duly failed the first
  // time it ran just past midnight UTC. Anchoring to the day boundary makes it
  // deterministic whatever time it runs.
  const now = new Date();
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const earlierToday = new Date(utcMidnight + 1000);
  const yesterday = new Date(utcMidnight - 12 * 60 * 60 * 1000);

  assert.strictEqual(stampsEarnedFor(program({ earnRule: 'VISIT' }), receipt(), null), 1);
  assert.strictEqual(stampsEarnedFor(program({ earnRule: 'VISIT' }), receipt(), { lastStampedAt: null }), 1);
  assert.strictEqual(stampsEarnedFor(program({ earnRule: 'VISIT' }), receipt(), { lastStampedAt: earlierToday }), 0);
  assert.strictEqual(stampsEarnedFor(program({ earnRule: 'VISIT' }), receipt(), { lastStampedAt: yesterday }), 1);
});

test('ITEM counts matching line items by quantity, case-insensitively', () => {
  const p = program({ earnRule: 'ITEM', earnItemName: 'Latte' });
  const r = receipt({
    lineItems: [
      { name: 'Large latte', quantity: 2 },
      { name: 'Blueberry muffin', quantity: 1 },
      { name: 'ICED LATTE', quantity: 1 },
    ],
  });
  assert.strictEqual(stampsEarnedFor(p, r, null), 3);
});

test('ITEM earns nothing when the product is absent, or not yet named', () => {
  const named = program({ earnRule: 'ITEM', earnItemName: 'Latte' });
  assert.strictEqual(stampsEarnedFor(named, receipt({ lineItems: [{ name: 'Croissant', quantity: 1 }] }), null), 0);
  assert.strictEqual(stampsEarnedFor(program({ earnRule: 'ITEM' }), receipt({ lineItems: [{ name: 'Latte', quantity: 1 }] }), null), 0);
});

test('ITEM treats a missing or unusable quantity as one unit', () => {
  const p = program({ earnRule: 'ITEM', earnItemName: 'latte' });
  assert.strictEqual(stampsEarnedFor(p, receipt({ lineItems: [{ name: 'Latte' }] }), null), 1);
  assert.strictEqual(stampsEarnedFor(p, receipt({ lineItems: [{ name: 'Latte', quantity: 'two' }] }), null), 1);
  assert.strictEqual(stampsEarnedFor(p, receipt({ lineItems: [{ name: 'Latte', quantity: 0 }] }), null), 1);
});

test('ITEM survives a POS that sent something other than an array of items', () => {
  const p = program({ earnRule: 'ITEM', earnItemName: 'latte' });
  assert.strictEqual(stampsEarnedFor(p, receipt({ lineItems: null }), null), 0);
  assert.strictEqual(stampsEarnedFor(p, receipt({ lineItems: [null, { quantity: 1 }] }), null), 0);
});

test('AMOUNT gives whole stamps only, never a partial one', () => {
  const p = program({ earnRule: 'AMOUNT', earnAmountCents: 1000 });
  assert.strictEqual(stampsEarnedFor(p, receipt({ total: 2700 }), null), 2);
  assert.strictEqual(stampsEarnedFor(p, receipt({ total: 999 }), null), 0);
  assert.strictEqual(stampsEarnedFor(p, receipt({ total: 3000 }), null), 3);
});

test('AMOUNT earns nothing rather than dividing by zero', () => {
  assert.strictEqual(stampsEarnedFor(program({ earnRule: 'AMOUNT', earnAmountCents: 0 }), receipt(), null), 0);
});

// --- Card design defaults ---------------------------------------------------

const { readableInkFor, resolveCardDesign } = require('../routes/loyalty');

test('the default ink is whichever of white/near-black is readable on the card', () => {
  assert.strictEqual(readableInkFor('#0A84FF'), '#FFFFFF');
  assert.strictEqual(readableInkFor('#111111'), '#FFFFFF');
  assert.strictEqual(readableInkFor('#FFFFFF'), '#111111');
  assert.strictEqual(readableInkFor('#FFEB3B'), '#111111'); // pale yellow -- white would vanish
  assert.strictEqual(readableInkFor('#ff0'), '#111111'); // three-digit hex
});

test('unreadable input falls back to white rather than throwing', () => {
  assert.strictEqual(readableInkFor('bogus'), '#FFFFFF');
  assert.strictEqual(readableInkFor(''), '#FFFFFF');
  assert.strictEqual(readableInkFor(null), '#FFFFFF');
});

test('a merchant with no card logo inherits the one from their receipt', () => {
  const design = resolveCardDesign(
    { cardBackground: '#0A84FF', cardAccent: '#FFFFFF', cardLogoUrl: null },
    { logoUrl: '/uploads/logos/receipt.png', displayName: null },
    { businessName: 'Bean There' },
  );
  assert.strictEqual(design.logoUrl, '/uploads/logos/receipt.png');
  assert.strictEqual(design.logoIsInherited, true);
  assert.strictEqual(design.businessName, 'Bean There');
});

test('an uploaded card logo wins over the receipt one', () => {
  const design = resolveCardDesign(
    { cardBackground: '#0A84FF', cardAccent: '#FFFFFF', cardLogoUrl: '/uploads/logos/card.png' },
    { logoUrl: '/uploads/logos/receipt.png' },
    { businessName: 'Bean There' },
  );
  assert.strictEqual(design.logoUrl, '/uploads/logos/card.png');
  assert.strictEqual(design.logoIsInherited, false);
});

test('with no logo anywhere the card falls back to a monogram', () => {
  const design = resolveCardDesign({}, null, { businessName: 'bean there' });
  assert.strictEqual(design.logoUrl, null);
  assert.strictEqual(design.logoIsInherited, false);
  assert.strictEqual(design.monogram, 'B');
});

test('displayName is what customers see, so it wins over the account name', () => {
  const design = resolveCardDesign({}, { displayName: 'Kettle & Co' }, { businessName: 'Kettle Holdings LLC' });
  assert.strictEqual(design.businessName, 'Kettle & Co');
  assert.strictEqual(design.monogram, 'K');
});

test('a merchant with no name at all still gets a card, not a crash', () => {
  const design = resolveCardDesign({}, null, null);
  assert.strictEqual(design.businessName, 'Your business');
  assert.strictEqual(design.monogram, '★');
  assert.strictEqual(design.background, '#0A84FF');
  assert.strictEqual(design.accent, '#FFFFFF');
});
