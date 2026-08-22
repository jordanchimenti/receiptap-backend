// services/receiptAutoSave.js
// Card recognition: when a Square sale arrives for a card we've been given
// permission to recognise, the receipt lands in that shopper's wallet without
// them tapping anything.
//
// Consent is enforced structurally rather than re-checked here. A
// ShopperIdentifier row only exists because someone explicitly opted in
// (routes/email-capture.js), and findShopperByIdentifierHash ignores revoked
// rows -- so a match IS live consent. There is no path to a match without one.
//
// Square only. Every other platform's sales carry no fingerprint, so nothing
// matches and those shoppers keep tapping, which is the intended degradation.
//
// Best-effort throughout: this runs inside the POS webhook, and a failure to
// recognise someone must never cost a merchant their receipt.
const prisma = require('../lib/prisma');
const { findShopperByIdentifierHash } = require('./shopperIdentity');

// The one platform whose fingerprints this recognises. Kept as a constant and
// checked against the SALE's own provider below, rather than assumed: matching
// a hash from one platform against another platform's identifiers is the exact
// thing this design forbids, and a hard-coded lookup platform with no
// corresponding check on the transaction is how that would happen by accident.
const RECOGNISED_PLATFORM = 'SQUARE';
const RECOGNISED_POS_PROVIDER = 'square';

async function autoSaveReceiptForKnownShopper(transaction, { onLinked } = {}) {
  if (!transaction?.cardFingerprintHash) return null;
  // Already claimed -- never overwrite a link someone made themselves.
  if (transaction.customerId) return null;
  // A hash from any other POS is a different namespace entirely. Refuse it
  // even if one somehow reached the column.
  if (transaction.posProvider !== RECOGNISED_POS_PROVIDER) return null;

  try {
    const shopper = await findShopperByIdentifierHash(
      'CARD_FINGERPRINT',
      transaction.cardFingerprintHash,
      RECOGNISED_PLATFORM
    );
    if (!shopper) return null;

    await prisma.transaction.update({
      where: { id: transaction.id },
      data: { customerId: shopper.id, autoSavedViaRecognition: true },
    });

    // Everything a manual save would have done, so an auto-saved receipt is a
    // first-class one: a loyalty punch where they're enrolled, and AI
    // categorisation so it's organised like the rest of their wallet. Both are
    // no-ops when they don't apply.
    if (typeof onLinked === 'function') {
      await onLinked({ transaction, shopper });
    }
    return shopper;
  } catch (err) {
    console.error('[receiptAutoSave] recognition failed (receipt unaffected):', err.message);
    return null;
  }
}

module.exports = { autoSaveReceiptForKnownShopper };
