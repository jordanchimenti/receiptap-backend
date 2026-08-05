// services/legalAcceptanceService.js
// Shared by routes/auth.js (signup) and routes/legal.js (re-acceptance
// interstitial) -- one place that writes LegalAcceptance rows, so both
// call sites stamp the exact same shape and can't drift from each other.
const prisma = require('../lib/prisma');
const { LEGAL_DOCUMENTS } = require('../config/legal');

// One row per document, all stamped with whatever version config/legal.js
// says is current *right now* -- never hand-typed, so a row can't end up
// recording a version that doesn't match what was actually shown on the
// page. Append-only: every call adds new rows, never updates existing ones.
async function recordLegalAcceptances(merchantId, req) {
  const ipAddress = req.ip || null;
  const userAgent = req.headers['user-agent'] || null;
  await prisma.legalAcceptance.createMany({
    data: Object.keys(LEGAL_DOCUMENTS).map((documentType) => ({
      merchantId,
      documentType,
      version: LEGAL_DOCUMENTS[documentType].version,
      ipAddress,
      userAgent,
    })),
  });
}

module.exports = { recordLegalAcceptances };
