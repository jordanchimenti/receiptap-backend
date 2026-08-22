// lib/safeRedirect.js
// Shared allowlist check for "where should this request go next" query/body
// params (post-signup destination, post-login redirect, post-re-acceptance
// return path) -- only relative /dashboard/* or /account/business/* paths
// are honored, so a link can never be crafted to send a merchant off to an
// external site. /account/business/* was added alongside routes/account-business.js
// (the wallet's dark reskin of the dashboard) so the legal re-acceptance
// interstitial can send a merchant back into the wallet, not just the real
// dashboard, when that's where they were.
function safeNextPath(next, fallback = '/dashboard/receipts-hub') {
  if (typeof next !== 'string') return fallback;
  const isBusinessHub = next === '/account/business';
  if (!next.startsWith('/dashboard/') && !next.startsWith('/account/business/') && !isBusinessHub) return fallback;
  // Blocks protocol-relative ("//evil.com") and scheme-smuggled
  // ("/dashboard/../https://evil.com") redirects while still allowing a
  // normal query string, e.g. "/dashboard/analytics?range=30d".
  if (next.startsWith('//') || next.includes('://')) return fallback;
  return next;
}

module.exports = { safeNextPath };
