// services/claimReceipt.js
// Links a receipt to a shopper's wallet -- the single definition of what
// "saving a receipt" does, shared by every path that can trigger it:
//   - tapping the puck while signed in (routes/receipt.js, on view)
//   - pressing Save/Print/Join on the receipt (POST /receipt/:id/save)
// Card recognition has its own entry point (services/receiptAutoSave.js)
// because it also records provenance and runs with no shopper present.
//
// Kept in one place so those paths can't drift on the two things that are
// easy to get wrong: refusing an already-claimed receipt, and doing the
// follow-on work (loyalty punch, categorisation) consistently.
const prisma = require('../lib/prisma');
const { incrementLoyaltyPunch } = require('../routes/loyalty');
const { categorizeInBackground } = require('./categorize-receipt');

/**
 * Returns one of:
 *   'claimed'        -- linked to this shopper just now
 *   'already-yours'  -- they already had it; nothing to do
 *   'owned-by-other' -- someone else claimed it first; left untouched
 *   'not-found'
 *
 * Never reassigns a receipt that belongs to somebody else. Receipt URLs
 * contain the POS's own transaction id and get shared, screenshotted and
 * left open on counters -- without this guard, opening someone else's link
 * while signed in silently transfers their receipt to you.
 */
async function claimReceiptForShopper(transactionId, shopperId) {
  if (!transactionId || !shopperId) return 'not-found';

  const transaction = await prisma.transaction.findUnique({
    where: { id: transactionId },
    include: { merchant: true },
  });
  if (!transaction) return 'not-found';
  if (transaction.customerId === shopperId) return 'already-yours';
  if (transaction.customerId) return 'owned-by-other';

  // Only claims rows that are still unclaimed, so two requests racing on the
  // same receipt can't both win -- the second updates 0 rows.
  const result = await prisma.transaction.updateMany({
    where: { id: transaction.id, customerId: null },
    data: { customerId: shopperId },
  });
  if (result.count === 0) return 'owned-by-other';

  await incrementLoyaltyPunch(transaction.merchantId, shopperId);
  if (!transaction.aiCategorizedAt) {
    categorizeInBackground(transaction, transaction.merchant.businessName);
  }
  return 'claimed';
}

module.exports = { claimReceiptForShopper };
