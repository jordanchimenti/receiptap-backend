// services/emailSuppressionService.js
// Backs the EmailSuppression model (prisma/schema.prisma) -- the list of
// (email, merchant) pairs that must never be re-enrolled in marketing,
// even after their receipts/consent history is purged. See the model's
// own doc comment in the schema for why this survives every other purge.
const crypto = require('crypto');
const prisma = require('../lib/prisma');

// Same normalization (lowercase, trim) as every other email comparison in
// this codebase (Customer.email lookups, etc.), then a plain SHA-256 --
// deterministic, so a future check with the same email always produces the
// same hash to match against, but the table itself never holds the
// plaintext address.
function hashEmail(email) {
  return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

// Call when a shopper unsubscribes or has their data deleted -- writes (or
// leaves alone, if one already exists) a suppression row for this
// email+merchant pair. Idempotent: calling it twice for the same pair is a
// no-op the second time, not a duplicate row.
async function suppressEmail({ email, merchantId, reason }) {
  const emailHash = hashEmail(email);
  const existing = await prisma.emailSuppression.findFirst({ where: { emailHash, merchantId } });
  if (existing) return existing;
  return prisma.emailSuppression.create({ data: { emailHash, merchantId, reason } });
}

// Call before writing any ShopperConsent MARKETING row with granted: true,
// or before sending any non-transactional email (no such sender exists in
// this codebase yet -- Resend is only ever used for password resets, see
// docs/DATA_INVENTORY.md -- but this is the check to use when one does).
async function isEmailSuppressed(email, merchantId) {
  const emailHash = hashEmail(email);
  const row = await prisma.emailSuppression.findFirst({ where: { emailHash, merchantId } });
  return Boolean(row);
}

module.exports = { hashEmail, suppressEmail, isEmailSuppressed };
