// test/pair-puck.test.js
// Tap-to-pair decides which till a puck's receipts go to. Getting it wrong
// doesn't fail loudly -- it quietly sends one register's receipts to another
// counter's puck. These cover the cases where guessing would be tempting.

const test = require('node:test');
const assert = require('node:assert');

const { findPairableSale, isAwaiting, claimAwaitingPuck, PAIR_WINDOW_MS } = require('../lib/pairPuck');

// Minimal stand-in for the two tables this module reads.
function fakePrisma({ transactions = [], pucks = [] }) {
  return {
    transaction: { findMany: async () => transactions },
    puck: {
      findMany: async () => pucks,
      update: async ({ where, data }) => ({ ...pucks.find((p) => p.id === where.id), ...data }),
    },
  };
}

const sale = (over = {}) => ({
  id: 'tx1', total: 2499, posLocationId: 'LOC-1', posDeviceId: null,
  createdAt: new Date(), ...over,
});

test('offers the most recent sale from a register no puck covers', async () => {
  const prisma = fakePrisma({
    transactions: [sale({ id: 'newest', posLocationId: 'LOC-2' }), sale({ id: 'older' })],
    pucks: [],
  });
  const found = await findPairableSale(prisma, 'm1');
  assert.strictEqual(found.id, 'newest');
});

test('skips a sale whose register already has a puck', async () => {
  // Offering it would re-point a working puck at a till already covered --
  // harder to notice than no pairing at all.
  const prisma = fakePrisma({
    transactions: [sale({ posLocationId: 'LOC-1' })],
    pucks: [{ posLocationId: 'LOC-1', posDeviceId: null }],
  });
  assert.strictEqual(await findPairableSale(prisma, 'm1'), null);
});

test('a lane with its own device is separate from the location it sits in', async () => {
  // Square exposes locations, not lanes. A puck covering the location as a
  // whole must not swallow a second lane that reports its own device id.
  const prisma = fakePrisma({
    transactions: [sale({ id: 'lane2', posDeviceId: 'DEV-2' })],
    pucks: [{ posLocationId: 'LOC-1', posDeviceId: 'DEV-1' }],
  });
  const found = await findPairableSale(prisma, 'm1');
  assert.strictEqual(found.id, 'lane2');
});

test('returns nothing when there are no sales at all', async () => {
  assert.strictEqual(await findPairableSale(fakePrisma({}), 'm1'), null);
});

test('a wait expires rather than lingering', () => {
  const now = Date.now();
  assert.strictEqual(isAwaiting({ awaitingSaleAssignment: new Date(now - 60_000) }, { now }), true);
  assert.strictEqual(isAwaiting({ awaitingSaleAssignment: new Date(now - PAIR_WINDOW_MS - 1) }, { now }), false);
  assert.strictEqual(isAwaiting({ awaitingSaleAssignment: null }, { now }), false);
});

test('one waiting puck is claimed by the next uncovered sale', async () => {
  const prisma = fakePrisma({ pucks: [{ id: 'p1', awaitingSaleAssignment: new Date() }] });
  const bound = await claimAwaitingPuck(prisma, 'm1', sale({ posDeviceId: 'DEV-9' }));
  assert.strictEqual(bound.posDeviceId, 'DEV-9');
  assert.strictEqual(bound.awaitingSaleAssignment, null, 'the wait should be cleared');
});

test('two waiting pucks and one sale refuses to guess', async () => {
  // Two pucks tapped and one sale rung gives no way to tell which counter it
  // came from. Binding the wrong one sends receipts to the wrong till, so
  // neither is bound and the merchant tries again.
  const prisma = fakePrisma({
    pucks: [
      { id: 'p1', awaitingSaleAssignment: new Date() },
      { id: 'p2', awaitingSaleAssignment: new Date() },
    ],
  });
  assert.strictEqual(await claimAwaitingPuck(prisma, 'm1', sale()), null);
});

test('an expired wait is not claimed by a later sale', async () => {
  const prisma = fakePrisma({
    pucks: [{ id: 'p1', awaitingSaleAssignment: new Date(Date.now() - PAIR_WINDOW_MS - 1000) }],
  });
  assert.strictEqual(await claimAwaitingPuck(prisma, 'm1', sale()), null);
});

test('no waiting pucks means a sale changes nothing', async () => {
  const prisma = fakePrisma({ pucks: [{ id: 'p1', awaitingSaleAssignment: null }] });
  assert.strictEqual(await claimAwaitingPuck(prisma, 'm1', sale()), null);
});
