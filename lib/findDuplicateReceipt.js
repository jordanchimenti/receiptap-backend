// lib/findDuplicateReceipt.js
// Has this customer already got this receipt?
//
// Checks BOTH kinds. Photographing a receipt you were also handed digitally is
// the most likely way to end up with a duplicate, so looking only at previous
// scans would miss the common case.
//
// Matching is deliberately narrow: same merchant, same total, same calendar
// day. Two genuinely separate purchases matching on all three is possible (two
// identical coffees on one day) — which is exactly why this only ever WARNS.
// Nothing is blocked; the customer is told and decides.

const prisma = require('./prisma');

// Merchant names arrive from OCR and from POS records, so they differ in case,
// punctuation and spacing far more than they differ in substance.
function normalizeMerchant(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function sameCalendarDay(a, b) {
  if (!a || !b) return false;
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

/**
 * Returns a short description of the existing receipt, or null when this looks
 * new. `excludeScannedId` skips a row when re-checking one that already exists.
 */
async function findDuplicateReceipt({ customerId, merchantName, totalCents, purchaseDate, excludeScannedId }) {
  if (!merchantName || totalCents == null) return null;

  const target = normalizeMerchant(merchantName);
  if (!target) return null;

  // Same total is the cheap, indexable half of the match -- filter on it in
  // the database and compare names in memory, since normalizing a name isn't
  // something SQL can do consistently across both tables.
  const [scanned, tapped] = await Promise.all([
    prisma.scannedReceipt.findMany({
      where: { customerId, total: totalCents, ...(excludeScannedId ? { NOT: { id: excludeScannedId } } : {}) },
      select: { id: true, merchantName: true, purchaseDate: true, createdAt: true },
    }),
    prisma.transaction.findMany({
      where: { customerId, total: totalCents },
      select: { id: true, createdAt: true, merchant: { select: { businessName: true } } },
    }),
  ]);

  const wanted = purchaseDate ? new Date(purchaseDate) : null;

  const scannedHit = scanned.find(
    (r) => normalizeMerchant(r.merchantName) === target && sameCalendarDay(r.purchaseDate || r.createdAt, wanted),
  );
  if (scannedHit) {
    return { kind: 'scanned', id: scannedHit.id, merchantName: scannedHit.merchantName, date: scannedHit.purchaseDate || scannedHit.createdAt };
  }

  const tappedHit = tapped.find(
    (t) => normalizeMerchant(t.merchant?.businessName) === target && sameCalendarDay(t.createdAt, wanted),
  );
  if (tappedHit) {
    return { kind: 'tapped', id: tappedHit.id, merchantName: tappedHit.merchant.businessName, date: tappedHit.createdAt };
  }

  return null;
}

module.exports = { findDuplicateReceipt, normalizeMerchant };
