// lib/safeRedirect.js
// Shared allowlist check for "where should this request go next" query/body
// params (post-signup destination, post-login redirect, post-re-acceptance
// return path) -- only relative /dashboard/* paths are honored, so a link
// can never be crafted to send a merchant off to an external site.
function safeNextPath(next, fallback = '/dashboard/receipts-hub') {
  if (typeof next !== 'string') return fallback;
  if (!next.startsWith('/dashboard/')) return fallback;
  // Blocks protocol-relative ("//evil.com") and scheme-smuggled
  // ("/dashboard/../https://evil.com") redirects while still allowing a
  // normal query string, e.g. "/dashboard/analytics?range=30d".
  if (next.startsWith('//') || next.includes('://')) return fallback;
  return next;
}

module.exports = { safeNextPath };
