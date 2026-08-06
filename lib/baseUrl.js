// lib/baseUrl.js
// Shared "what domain should a public-facing link use" helper -- same fix
// as PUCK_BASE_URL (routes/admin.js) applied to every other place that
// builds a link meant to be shared or clicked from outside this app
// (affiliate referral links, the partner-program card on a shopper's
// receipt). Without APP_BASE_URL set, a link built from req.protocol/
// req.get('host') is only ever as good as whatever host the page happened
// to be loaded from -- "localhost:3000" if a merchant is viewing their own
// dashboard locally, which then gets copied and shared as if it were real.
// Setting APP_BASE_URL pins every one of these links to the real domain
// regardless of where the page rendering it was loaded from.
function getBaseUrl(req) {
  return process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

module.exports = { getBaseUrl };
