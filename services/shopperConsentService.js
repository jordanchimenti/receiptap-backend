// services/shopperConsentService.js
// Called once per email-capture on the tap screen (routes/email-capture.js),
// from both the plain-email path and the Google Sign-In path. Always writes
// TWO rows: TRANSACTIONAL is always granted (receiving the receipt requires
// an email, it's not something the shopper opts into), MARKETING reflects
// whatever the checkbox actually was -- including false. Append-only: a
// decline is logged the same way a grant is, never silently skipped.
const prisma = require('../lib/prisma');
const { SHOPPER_CONSENT } = require('../config/legal');
const { isEmailSuppressed } = require('./emailSuppressionService');

// merchantId + email are needed (not just receiptId) to check
// EmailSuppression before honoring a MARKETING opt-in -- a shopper who
// previously unsubscribed or asked to be deleted from THIS merchant must
// not get silently re-enrolled just because they tapped another receipt
// and happened to leave the checkbox ticked (or the client sent a stale
// value). The checkbox's actual state is still what gets logged when
// nobody's suppressed -- this only ever forces true toward false, never
// the reverse.
async function recordShopperConsent({ receiptId, merchantId, email, marketingGranted }, req) {
  const ipAddress = req.ip || null;
  let granted = Boolean(marketingGranted);
  if (granted && (await isEmailSuppressed(email, merchantId))) {
    granted = false;
  }

  await prisma.shopperConsent.createMany({
    data: [
      { receiptId, consentType: 'TRANSACTIONAL', granted: true, consentTextVersion: SHOPPER_CONSENT.version, ipAddress },
      { receiptId, consentType: 'MARKETING', granted, consentTextVersion: SHOPPER_CONSENT.version, ipAddress },
    ],
  });
}

module.exports = { recordShopperConsent };
