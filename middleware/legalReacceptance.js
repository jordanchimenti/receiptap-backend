// middleware/legalReacceptance.js
// Blocks dashboard access if a merchant's most recent acceptance of any
// legal document is behind the version currently live in config/legal.js --
// including merchants who signed up before this feature existed and have
// no acceptance rows at all (treated the same as "outdated", not an error).
//
// Mounted on /dashboard in server.js, same pattern as subscriptionGate.
// Ordering: this only needs to run after ownerFlag has set res.locals for
// the views it might render on its way to a redirect -- ownerFlag's own
// constraint (CLAUDE.md: must be mounted before the dashboard routes) is
// unaffected either way, since this middleware never touches res.locals.isOwner.
const prisma = require('../lib/prisma');
const { LEGAL_DOCUMENTS, isNewerVersion } = require('../config/legal');

async function requireCurrentLegalAcceptance(req, res, next) {
  try {
    const documentTypes = Object.keys(LEGAL_DOCUMENTS);

    const latestByType = await Promise.all(
      documentTypes.map((documentType) =>
        prisma.legalAcceptance.findFirst({
          where: { merchantId: req.session.merchantId, documentType },
          orderBy: { acceptedAt: 'desc' },
        })
      )
    );

    const isStale = documentTypes.some((documentType, i) => {
      const latest = latestByType[i];
      if (!latest) return true; // no acceptance on file at all
      return isNewerVersion(LEGAL_DOCUMENTS[documentType].version, latest.version);
    });

    if (isStale) {
      return res.redirect(`/legal/reaccept?next=${encodeURIComponent(req.originalUrl)}`);
    }

    next();
  } catch (err) {
    // A broken check should never lock every merchant out of their own
    // dashboard -- same "fail open, log it" posture as the rest of this
    // codebase's best-effort background checks (e.g. AI categorization).
    console.error('Legal re-acceptance check failed:', err);
    next();
  }
}

module.exports = { requireCurrentLegalAcceptance };
