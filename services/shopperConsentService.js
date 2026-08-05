// services/shopperConsentService.js
// Called once per email-capture on the tap screen (routes/email-capture.js),
// from both the plain-email path and the Google Sign-In path. Always writes
// TWO rows: TRANSACTIONAL is always granted (receiving the receipt requires
// an email, it's not something the shopper opts into), MARKETING reflects
// whatever the checkbox actually was -- including false. Append-only: a
// decline is logged the same way a grant is, never silently skipped.
const prisma = require('../lib/prisma');
const { SHOPPER_CONSENT } = require('../config/legal');

async function recordShopperConsent(receiptId, marketingGranted, req) {
  const ipAddress = req.ip || null;
  await prisma.shopperConsent.createMany({
    data: [
      { receiptId, consentType: 'TRANSACTIONAL', granted: true, consentTextVersion: SHOPPER_CONSENT.version, ipAddress },
      { receiptId, consentType: 'MARKETING', granted: Boolean(marketingGranted), consentTextVersion: SHOPPER_CONSENT.version, ipAddress },
    ],
  });
}

module.exports = { recordShopperConsent };
