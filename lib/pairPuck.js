// lib/pairPuck.js
// Tap-to-pair: how a puck learns which register it sits on.
//
// The old way was a dropdown. A merchant stood at a counter holding a puck and
// had to match it to a list entry by the first four characters of its ID, from
// a screen, for every till. Worse on Square, which doesn't expose lanes at all
// -- ReceipTap can only infer a register from a sale that already carried a
// device ID, so lane 2 couldn't be assigned until lane 2 had already sold
// something.
//
// Tapping solves both. The puck's own URL says which puck it is, and a real
// sale says which register it came from, so neither has to be typed or
// recognised. Pairing works in whichever order suits the counter:
//
//   sale first  -- ring one, tap the puck, confirm the register it names
//   tap first   -- tap the puck, ring a sale, the sale claims the waiting puck
//
// Both land in the same place: posLocationId/posDeviceId on the puck, which is
// exactly what routes/webhooks.js already matches sales against.

// How long a sale stays pairable, and how long a tapped puck waits for one.
// Generous on purpose -- a merchant may walk to the back office between the
// two halves -- but not unbounded, or a puck tapped this morning would silently
// grab an unrelated sale this afternoon.
const PAIR_WINDOW_MS = 15 * 60 * 1000;

/**
 * The most recent sale that no puck would currently receive.
 *
 * A sale whose register already has a puck is deliberately skipped: offering
 * it would re-point a working puck at a till that is already covered, which is
 * a harder mistake to notice than no pairing at all.
 *
 * @returns the transaction to pair against, or null if there isn't one
 */
async function findPairableSale(prisma, merchantId, { now = Date.now() } = {}) {
  const recent = await prisma.transaction.findMany({
    where: {
      merchantId,
      createdAt: { gte: new Date(now - PAIR_WINDOW_MS) },
      posLocationId: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  if (recent.length === 0) return null;

  const pucks = await prisma.puck.findMany({
    where: { merchantId },
    select: { posLocationId: true, posDeviceId: true },
  });

  const covered = (tx) =>
    pucks.some(
      (p) =>
        (tx.posDeviceId && p.posDeviceId === tx.posDeviceId) ||
        (p.posLocationId === tx.posLocationId && !p.posDeviceId)
    );

  return recent.find((tx) => !covered(tx)) || null;
}

/** Write a sale's register onto a puck. The one place that mapping is set. */
async function bindPuckToSale(prisma, puckId, transaction) {
  return prisma.puck.update({
    where: { id: puckId },
    data: {
      posLocationId: transaction.posLocationId,
      posDeviceId: transaction.posDeviceId || null,
      awaitingSaleAssignment: null,
    },
  });
}

/** True while a puck is still waiting for a sale to claim it. */
function isAwaiting(puck, { now = Date.now() } = {}) {
  return Boolean(
    puck.awaitingSaleAssignment && new Date(puck.awaitingSaleAssignment).getTime() > now - PAIR_WINDOW_MS
  );
}

/**
 * Called from the webhook when a sale matched no puck by location or device.
 * If exactly one puck is waiting to be paired, this is the sale it was waiting
 * for. More than one waiting is refused rather than guessed at: two pucks
 * tapped and one sale rung gives no way to tell which counter it came from,
 * and binding the wrong one sends receipts to the wrong till.
 */
async function claimAwaitingPuck(prisma, merchantId, transaction, { now = Date.now() } = {}) {
  const waiting = (
    await prisma.puck.findMany({
      where: { merchantId, awaitingSaleAssignment: { not: null } },
    })
  ).filter((p) => isAwaiting(p, { now }));

  if (waiting.length !== 1) return null;
  return bindPuckToSale(prisma, waiting[0].id, transaction);
}

module.exports = { findPairableSale, bindPuckToSale, isAwaiting, claimAwaitingPuck, PAIR_WINDOW_MS };
