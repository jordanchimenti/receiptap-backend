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

// A test receipt is the exception to the rule above. APP_BASE_URL exists so a
// link a CUSTOMER will follow -- a puck's URL, an affiliate referral -- always
// points at the real domain no matter where the page building it was loaded.
// A test sale is the opposite: a short-lived link the merchant opens for
// themselves, from the same environment that just minted its token. Pinning it
// to the production domain sends them to a deployment that may not have the
// feature yet (it 404s) or may not share the signing secret, so the one link
// guaranteed to work is the host they are already on.
function getSelfUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// Same idea for code that has no `req` at all -- background jobs and email,
// which are exactly the places a link matters most and the place a request
// object was never available. Returns null rather than guessing when
// APP_BASE_URL isn't set: an email carrying a link to "localhost:3000" is
// worse than one carrying no link, because the reader can't tell it's broken
// until they tap it.
function getAppUrl(path = '/') {
  const base = process.env.APP_BASE_URL;
  if (!base) return null;
  return base.replace(/\/+$/, '') + (path.startsWith('/') ? path : '/' + path);
}

module.exports = { getBaseUrl, getSelfUrl, getAppUrl };
