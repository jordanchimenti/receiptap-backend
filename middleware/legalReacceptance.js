// middleware/legalReacceptance.js
// Blocks dashboard access if a merchant's most recent acceptance of any
// legal document (TERMS/PRIVACY/DPA, checked independently) is behind the
// version currently live in config/legal.js -- including merchants who
// signed up before this feature existed and have no acceptance rows at
// all (treated the same as "outdated", not an error). A version bump to
// ANY ONE of the three is enough to redirect -- see
// getStaleDocumentTypes() in services/legalAcceptanceService.js, the
// shared source of truth for this check (also used by routes/legal.js to
// render/record the interstitial itself).
//
// Mounted on /dashboard in server.js, same pattern as subscriptionGate.
// Ordering: this only needs to run after ownerFlag has set res.locals for
// the views it might render on its way to a redirect -- ownerFlag's own
// constraint (CLAUDE.md: must be mounted before the dashboard routes) is
// unaffected either way, since this middleware never touches res.locals.isOwner.
const { getStaleDocumentTypes } = require('../services/legalAcceptanceService');

async function requireCurrentLegalAcceptance(req, res, next) {
  try {
    const staleTypes = await getStaleDocumentTypes(req.session.merchantId);

    if (staleTypes.length > 0) {
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
