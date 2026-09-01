// middleware/shopperLegalReacceptance.js
// The wallet-side mirror of middleware/legalReacceptance.js -- blocks wallet
// access if a customer's most recent acceptance of SHOPPER_TERMS or
// SHOPPER_PRIVACY (checked independently) is behind the version currently
// live in config/legal.js, including customers who signed up before this
// feature existed and have no acceptance rows at all (treated the same as
// "outdated", not an error) -- same reasoning as the merchant version.
//
// Mounted on /account in server.js, excluding /account/business (the
// merchant surface has its own copy of this gate already) and the handful
// of paths a signed-out or mid-flow visitor needs to reach regardless
// (login, signup, the legal documents themselves, /legal/wallet-reaccept).
const { getStaleShopperDocumentTypes } = require('../services/legalAcceptanceService');

async function requireCurrentShopperLegalAcceptance(req, res, next) {
  try {
    const staleTypes = await getStaleShopperDocumentTypes(req.session.customerId);

    if (staleTypes.length > 0) {
      return res.redirect(`/legal/wallet-reaccept?next=${encodeURIComponent(req.originalUrl)}`);
    }

    next();
  } catch (err) {
    // A broken check should never lock every shopper out of their own
    // wallet -- same "fail open, log it" posture as the merchant version.
    console.error('Shopper legal re-acceptance check failed:', err);
    next();
  }
}

module.exports = { requireCurrentShopperLegalAcceptance };
