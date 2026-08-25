// lib/receiptMissingFields.js
//
// What CRA/IRS substantiation a specific receipt is missing -- shared
// between the individual scanned-receipt page and the bulk tax export so the
// two can never disagree about which fields count. Deliberately limited to
// fields a receipt is normally expected to carry (see the ScannedReceipt and
// Transaction comments in prisma/schema.prisma for why each one matters) --
// a missing tip line on a clothing purchase is not a gap.
//
// `kind` is 'scanned' or 'tapped'. The two checklists differ because the two
// models carry different fields, not because the rules themselves differ:
//   - A tapped receipt's time comes from the POS webhook itself
//     (Transaction.createdAt), not OCR'd text, so it's never missing the way
//     a photographed receipt's printed time can be.
//   - A tapped receipt's own identifier (Transaction.id, "reuse the POS's
//     own transaction ID") always exists, unlike a scanned receipt's
//     receiptNumber, which is only ever what the AI could read off the
//     photo.
//   - Transaction has no buyerName field at all -- there's nowhere on a POS
//     payload to put one, so that check can only ever apply to scanned
//     receipts. See docs/KNOWN_ISSUES.md.
function missingSubstantiationFields(kind, row) {
  const missing = [];

  if (kind === 'scanned') {
    if (!row.taxNumber) missing.push('a tax registration number');
    if (!row.receiptNumber) missing.push('a receipt number');
    if (!row.paymentMethod) missing.push('how it was paid');
    if (!row.purchaseTimeText) missing.push('the time of day');
    // CRA only requires the buyer be named once a purchase reaches $500
    // (raised from $150 by SOR/2021-63, effective April 20, 2021), so
    // flagging it below that would be noise on almost every till receipt.
    if (!row.buyerName && row.total >= 50000) missing.push("the buyer's name (CRA asks for it over $500)");
    return missing;
  }

  if (!row.sellerGstHstNumber) missing.push('a tax registration number');
  if (!row.paymentMethod) missing.push('how it was paid');
  return missing;
}

module.exports = { missingSubstantiationFields };
