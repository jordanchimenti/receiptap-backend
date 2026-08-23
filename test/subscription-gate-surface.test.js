// A blocked merchant (INCOMPLETE/CANCELED) gets sent to billing. Which
// billing page depends on the surface they came in through: sending everyone
// to /dashboard/billing threw wallet merchants out of the dark Business
// section and onto the navy sidebar dashboard on the first load after login.

const { test } = require('node:test');
const assert = require('node:assert');

const { billingBasePath } = require('../middleware/subscriptionGate');

test('a merchant blocked inside the wallet stays in the wallet', () => {
  assert.strictEqual(
    billingBasePath({ originalUrl: '/account/business' }),
    '/account/business/billing'
  );
});

test('deeper wallet pages resolve to the wallet billing page too', () => {
  for (const url of [
    '/account/business/receipts',
    '/account/business/analytics?days=30',
    '/account/business/pucks',
  ]) {
    assert.strictEqual(billingBasePath({ originalUrl: url }), '/account/business/billing', url);
  }
});

test('the navy sidebar dashboard keeps its own billing page', () => {
  for (const url of ['/dashboard', '/dashboard/receipts', '/dashboard/settings/receipt']) {
    assert.strictEqual(billingBasePath({ originalUrl: url }), '/dashboard/billing', url);
  }
});

test('the wallet customer section is not mistaken for the business section', () => {
  // /account/receipts is the shopper wallet -- it must not resolve to the
  // merchant wallet's billing page just because it starts with /account.
  assert.strictEqual(billingBasePath({ originalUrl: '/account/receipts' }), '/dashboard/billing');
});
