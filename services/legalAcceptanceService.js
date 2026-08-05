// services/legalAcceptanceService.js
// Shared by routes/auth.js (signup), routes/legal.js (re-acceptance
// interstitial), and middleware/legalReacceptance.js (the gate that sends a
// merchant to that interstitial) -- one place that reads/writes
// LegalAcceptance rows, so all three call sites can't drift from each other.
const prisma = require('../lib/prisma');
const { LEGAL_DOCUMENTS, isNewerVersion } = require('../config/legal');

// Which document types (TERMS/PRIVACY/DPA) this merchant's most recent
// acceptance is behind on, or has never accepted at all. Shared by
// middleware/legalReacceptance.js (decides whether to redirect at all) and
// routes/legal.js (decides what to show, and which type(s) to write a fresh
// row for on submit) -- one query, not the same version-comparison loop
// duplicated in three places.
async function getStaleDocumentTypes(merchantId) {
  const documentTypes = Object.keys(LEGAL_DOCUMENTS);
  const latestByType = await Promise.all(
    documentTypes.map((documentType) =>
      prisma.legalAcceptance.findFirst({
        where: { merchantId, documentType },
        orderBy: { acceptedAt: 'desc' },
      })
    )
  );
  return documentTypes.filter((documentType, i) => {
    const latest = latestByType[i];
    if (!latest) return true; // no acceptance on file at all
    return isNewerVersion(LEGAL_DOCUMENTS[documentType].version, latest.version);
  });
}

// One row per document type passed in, stamped with whatever version
// config/legal.js says is current *right now* -- never hand-typed, so a
// row can't end up recording a version that doesn't match what was
// actually shown on the page. Append-only: every call adds new rows, never
// updates existing ones.
//
// documentTypes defaults to ALL THREE (TERMS/PRIVACY/DPA) -- that's what
// signup uses, and it must stay that way EVEN THOUGH SIGNUP ONLY HAS ONE
// CHECKBOX NOW. Don't "simplify" that call site to one row. The signup
// checkbox reads "I agree to the Terms of Service, which include the Data
// Processing Agreement, and I have read the Privacy Policy" -- one tick,
// but it names all three documents, and legal-terms-content.ejs's "Data and
// privacy" section incorporates the DPA into the Terms by reference. So
// checking that one box is still, legally, acceptance of all three -- and
// each of those three documents can change wording and bump its OWN
// version independent of the others (e.g. a subprocessor change bumps
// DPA.version alone, see CLAUDE.md). If signup only wrote one row, there'd
// be no way to prove which specific DPA version -- or PRIVACY version -- a
// given merchant actually agreed to once any one of the three has since
// moved on. Three rows is what makes each document's version independently
// provable from a single acceptance event, which is the entire point of
// this table existing.
//
// The re-acceptance flow (routes/legal.js) is the one caller that passes an
// explicit, narrower documentTypes -- only whatever getStaleDocumentTypes()
// found stale for that merchant. That's deliberately different from
// signup: a merchant re-accepting because DPA changed already has current,
// untouched TERMS and PRIVACY rows on file -- there's nothing to re-affirm
// there, so no new row is written for them. Only DPA gets a fresh row.
async function recordLegalAcceptances(merchantId, req, documentTypes = Object.keys(LEGAL_DOCUMENTS)) {
  const ipAddress = req.ip || null;
  const userAgent = req.headers['user-agent'] || null;
  await prisma.legalAcceptance.createMany({
    data: documentTypes.map((documentType) => ({
      merchantId,
      documentType,
      version: LEGAL_DOCUMENTS[documentType].version,
      ipAddress,
      userAgent,
    })),
  });
}

module.exports = { recordLegalAcceptances, getStaleDocumentTypes };
