// The wallet's dark Business section (views/business-*.ejs) is the dashboard
// merchants land on after login. A link from one of those pages into the navy
// sidebar dashboard (/dashboard/*) strands them on the old surface with no way
// back -- which is exactly how an INCOMPLETE merchant ended up on the old
// dashboard trying to start a trial.
//
// File downloads are the deliberate exception: those endpoints answer with
// Content-Disposition: attachment, so the browser saves a file and never
// navigates away from the wallet page.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const VIEWS_DIR = path.join(__dirname, '..', 'views');

// Verified to set Content-Disposition: attachment -- see routes/analytics.js,
// merchant-dashboard.js, email-capture.js, repeat-customers.js, pdf-export.js
// and merchant-expenses.js.
const DOWNLOAD_ENDPOINTS = /^\/dashboard\/[a-z-]+\/(pdf-)?export\b/;

// POST targets that never leave the merchant on a /dashboard page. Each was
// checked by hand; an `action` is only excused if the handler provably comes
// back. A plain `href` is never excused -- that always navigates.
//   disconnect-pos    -- reads redirectTo, allowlisted against
//                        '/account/business/pos' (routes/account-settings.js)
//   business-all      -- settingsRedirectTarget(redirectTo), WALLET_SETTINGS_PATHS
//   password          -- same settingsRedirectTarget round-trip
//   profile           -- same settingsRedirectTarget round-trip; posted from
//                        views/business-account.ejs, redirectTo
//                        '/account/business/account', which is itself in
//                        WALLET_SETTINGS_PATHS
//   deactivate        -- destroys the session and redirects to /login
//   connect-toast     -- reads redirectTo, allowlisted against
//                        '/account/business/pos' via posReturnPath
//                        (routes/toast.js), same round-trip disconnect-pos
//                        uses -- Toast has no OAuth redirect to round-trip
//                        through instead
const ROUND_TRIPS_SURFACE = new Set([
  '/dashboard/settings/account/disconnect-pos',
  '/dashboard/settings/account/business-all',
  '/dashboard/settings/account/password',
  '/dashboard/settings/account/profile',
  '/dashboard/settings/account/deactivate',
  '/dashboard/pos-setup/connect-toast',
]);

function walletViews() {
  return fs
    .readdirSync(VIEWS_DIR)
    .filter((f) => f.startsWith('business-') && f.endsWith('.ejs'));
}

test('no wallet page navigates the merchant into the navy dashboard', () => {
  const offenders = [];

  for (const file of walletViews()) {
    const src = fs.readFileSync(path.join(VIEWS_DIR, file), 'utf8');
    const attr = /(href|action)="(\/dashboard\/[^"]*)"/g;
    let m;
    while ((m = attr.exec(src)) !== null) {
      const [, kind, target] = m;
      if (DOWNLOAD_ENDPOINTS.test(target)) continue;
      // Only a form POST can earn an exemption, and only by name.
      if (kind === 'action' && ROUND_TRIPS_SURFACE.has(target)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${file}:${line} -> ${target}`);
    }
  }

  assert.deepStrictEqual(
    offenders,
    [],
    'wallet pages must link to /account/business/* equivalents:\n  ' + offenders.join('\n  ')
  );
});

test('the exception list only excuses real download endpoints', () => {
  // Guards the regex above from quietly widening into a blanket /dashboard pass.
  assert.ok(DOWNLOAD_ENDPOINTS.test('/dashboard/receipts/export?from=a&to=b'));
  assert.ok(DOWNLOAD_ENDPOINTS.test('/dashboard/receipts/pdf-export'));
  assert.ok(!DOWNLOAD_ENDPOINTS.test('/dashboard/billing'));
  assert.ok(!DOWNLOAD_ENDPOINTS.test('/dashboard/pos-setup'));
  assert.ok(!DOWNLOAD_ENDPOINTS.test('/dashboard/exported-thing'));
});
