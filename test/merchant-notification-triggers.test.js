// test/merchant-notification-triggers.test.js
// The decision logic behind when a merchant gets billing-problem notified
// (services/stripeService.js). A subscription sitting at PAST_DUE must not
// get renotified on every later Stripe event for the same subscription --
// that's the whole reason this is a pure, directly-testable function rather
// than just inlined in the webhook handler.

const test = require('node:test');
const assert = require('node:assert');

const { isNewBillingProblem } = require('../services/stripeService');

test('a genuine transition to PAST_DUE or CANCELED notifies', () => {
  assert.strictEqual(isNewBillingProblem('ACTIVE', 'PAST_DUE'), true);
  assert.strictEqual(isNewBillingProblem('TRIALING', 'CANCELED'), true);
  assert.strictEqual(isNewBillingProblem('PAST_DUE', 'CANCELED'), true);
});

test('staying at the same bad status does not renotify', () => {
  assert.strictEqual(isNewBillingProblem('PAST_DUE', 'PAST_DUE'), false);
  assert.strictEqual(isNewBillingProblem('CANCELED', 'CANCELED'), false);
});

test('a transition into a GOOD status never notifies', () => {
  assert.strictEqual(isNewBillingProblem('PAST_DUE', 'ACTIVE'), false);
  assert.strictEqual(isNewBillingProblem('CANCELED', 'TRIALING'), false);
  assert.strictEqual(isNewBillingProblem('ACTIVE', 'ACTIVE'), false);
});
