// test/email-links.test.js
// Standing rule: every email this app sends must contain a direct link to the
// thing it is about. The stamp-card email shipped without one -- it said
// "open it in your wallet under My Rewards" and left the reader to find the
// app and navigate there by name. This suite fails if any future sender is
// added without a link, rather than relying on someone noticing in an inbox.

const test = require('node:test');
const assert = require('node:assert');

// Stub the Resend SDK before emailService loads, so nothing is ever sent and
// the rendered payload can be inspected directly.
function loadServiceWithCapture({ baseUrl }) {
  const resendPath = require.resolve('resend');
  const captured = [];
  require.cache[resendPath] = {
    id: resendPath, filename: resendPath, loaded: true,
    exports: {
      Resend: class {
        constructor() {
          this.emails = { send: async (payload) => { captured.push(payload); return { data: { id: 'stub' }, error: null }; } };
        }
      },
    },
  };
  if (baseUrl) process.env.APP_BASE_URL = baseUrl; else delete process.env.APP_BASE_URL;
  process.env.RESEND_API_KEY = 'stub-key';
  delete require.cache[require.resolve('../lib/baseUrl')];
  delete require.cache[require.resolve('../services/emailService')];
  return { service: require('../services/emailService'), captured };
}

// One entry per sender. A new email means a new line here -- which is the
// point: the test only covers what it is told about, so adding a sender
// without adding it here should be caught in review.
const SENDERS = [
  {
    name: 'loyalty reward ready',
    call: (s) => s.sendLoyaltyRewardReadyEmail({ email: 'a@b.com', name: 'Jordan', merchantName: 'ReceipTap', reward: '10% off' }),
    mustLinkTo: '/account/loyalty',
  },
  {
    name: 'password reset',
    call: (s) => s.sendPasswordResetEmail({ email: 'a@b.com', name: 'Jordan' }, 'https://example.test/account/reset/tok'),
    mustLinkTo: '/account/reset/tok',
  },
  {
    name: 'email verification',
    call: (s) => s.sendVerificationEmail({ email: 'a@b.com', name: 'Jordan' }, 'https://example.test/verify/tok'),
    mustLinkTo: '/verify/tok',
  },
];

for (const sender of SENDERS) {
  test(`${sender.name} carries a direct link to what it is about`, async () => {
    const { service, captured } = loadServiceWithCapture({ baseUrl: 'https://www.receiptap.com' });
    await sender.call(service);
    assert.strictEqual(captured.length, 1, 'expected exactly one email');
    const html = captured[0].html;
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(hrefs.length > 0, `${sender.name} sent no link at all`);
    assert.ok(
      hrefs.some((h) => h.includes(sender.mustLinkTo)),
      `${sender.name} has links (${hrefs.join(', ')}) but none pointing at ${sender.mustLinkTo}`
    );
  });

  test(`${sender.name} sends no link at all rather than a broken one`, async () => {
    // With no APP_BASE_URL there is no domain to build an absolute link from.
    // A relative or localhost link in an inbox looks real until it's tapped,
    // so the button is dropped instead. Senders handed a full URL by their
    // caller (reset, verify) are unaffected -- they never needed the base.
    const { service, captured } = loadServiceWithCapture({ baseUrl: null });
    await sender.call(service);
    const html = captured[0].html;
    assert.ok(!/localhost/.test(html), 'leaked a localhost link into an email');
    assert.ok(!/href="\//.test(html), 'left a relative href, which cannot resolve from an inbox');
  });
}

test('merchant-supplied text is escaped before it reaches the HTML', async () => {
  // Business name and reward label are merchant-controlled and land in an
  // HTML email, so they get the same treatment as any string reaching a page.
  const { service, captured } = loadServiceWithCapture({ baseUrl: 'https://www.receiptap.com' });
  await service.sendLoyaltyRewardReadyEmail({
    email: 'a@b.com', name: 'Jordan',
    merchantName: '<script>alert(1)</script>', reward: 'Free coffee & cake',
  });
  const html = captured[0].html;
  assert.ok(!html.includes('<script>alert(1)</script>'), 'unescaped markup reached the email body');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('Free coffee &amp; cake'));
});

test('the opt-out sentence links to settings rather than describing them', async () => {
  const { service, captured } = loadServiceWithCapture({ baseUrl: 'https://www.receiptap.com' });
  await service.sendLoyaltyRewardReadyEmail({ email: 'a@b.com', name: 'Jordan', merchantName: 'Shop', reward: '10% off' });
  assert.ok(captured[0].html.includes('https://www.receiptap.com/account/settings'));
});
