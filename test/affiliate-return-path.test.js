// Where a merchant-affiliate lands when a Partner Program link doesn't say.
//
// The fallback used to be /dashboard/referrals, so opening Partner Program
// from the wallet's More page -- which passes no ?from= -- sent every CTA on
// the landing page to the navy sidebar dashboard, dropping the merchant onto
// a surface they weren't using.
//
// Callers that genuinely belong on the navy page name it explicitly (the
// /dashboard/referrals route passes redirectTo itself), so the fallback is
// only reached from the personal and public surfaces.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  affiliateReturnPath,
  DEFAULT_AFFILIATE_RETURN_PATH,
  ALLOWED_AFFILIATE_RETURN_PATHS,
} = require('../lib/affiliateReturnPath');

test('saying nothing lands on the wallet, not the navy dashboard', () => {
  for (const nothing of [undefined, null, '']) {
    assert.strictEqual(affiliateReturnPath(nothing), '/account/business/referrals');
  }
  assert.strictEqual(DEFAULT_AFFILIATE_RETURN_PATH, '/account/business/referrals');
});

test('an explicit surface is always honoured', () => {
  // The navy page still exists and its own forms round-trip through here --
  // flipping the default must not take that away from it.
  assert.strictEqual(affiliateReturnPath('/dashboard/referrals'), '/dashboard/referrals');
  assert.strictEqual(
    affiliateReturnPath('/account/business/referrals'),
    '/account/business/referrals'
  );
});

test('anything off the allowlist falls back rather than being trusted', () => {
  for (const hostile of [
    'https://evil.example/steal',
    '//evil.example',
    '/dashboard/referrals/../../etc',
    '/account/settings',
    'javascript:alert(1)',
    0,
    {},
  ]) {
    assert.strictEqual(
      affiliateReturnPath(hostile),
      '/account/business/referrals',
      String(hostile) + ' must not be returned as-is'
    );
  }
});

test('the default is itself an allowed path', () => {
  // A default outside the allowlist would be a redirect the validator would
  // reject if it ever came back in as input.
  assert.ok(ALLOWED_AFFILIATE_RETURN_PATHS.includes(DEFAULT_AFFILIATE_RETURN_PATH));
});
