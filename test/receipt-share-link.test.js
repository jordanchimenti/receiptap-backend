// test/receipt-share-link.test.js
// The token/expiry logic behind the scanned-receipt share link
// (routes/receiptShare.js, POST /account/receipts/scanned/:id/share). The
// route that streams the photo and the route that shows the shopper their
// current link both defer to isShareLinkActive() -- if this drifted, one
// could show a link as live while the other refuses to serve the photo.

const test = require('node:test');
const assert = require('node:assert');

const {
  shareLinkDays,
  generateShareToken,
  computeExpiresAt,
  isShareLinkActive,
} = require('../lib/receiptShareLink');

test('generateShareToken produces 256 bits of hex, and never repeats', () => {
  const a = generateShareToken();
  const b = generateShareToken();
  assert.strictEqual(a.length, 64); // 32 bytes as hex = 64 chars
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(a, b);
});

test('shareLinkDays defaults to 60 when RECEIPT_SHARE_LINK_DAYS is unset', () => {
  const original = process.env.RECEIPT_SHARE_LINK_DAYS;
  delete process.env.RECEIPT_SHARE_LINK_DAYS;
  try {
    assert.strictEqual(shareLinkDays(), 60);
  } finally {
    if (original === undefined) delete process.env.RECEIPT_SHARE_LINK_DAYS;
    else process.env.RECEIPT_SHARE_LINK_DAYS = original;
  }
});

test('shareLinkDays respects a valid env override', () => {
  const original = process.env.RECEIPT_SHARE_LINK_DAYS;
  process.env.RECEIPT_SHARE_LINK_DAYS = '14';
  try {
    assert.strictEqual(shareLinkDays(), 14);
  } finally {
    if (original === undefined) delete process.env.RECEIPT_SHARE_LINK_DAYS;
    else process.env.RECEIPT_SHARE_LINK_DAYS = original;
  }
});

test('shareLinkDays falls back to the default for garbage or non-positive values', () => {
  const original = process.env.RECEIPT_SHARE_LINK_DAYS;
  try {
    for (const bad of ['0', '-5', 'abc', '', '  ']) {
      process.env.RECEIPT_SHARE_LINK_DAYS = bad;
      assert.strictEqual(shareLinkDays(), 60, `expected default for ${JSON.stringify(bad)}`);
    }
  } finally {
    if (original === undefined) delete process.env.RECEIPT_SHARE_LINK_DAYS;
    else process.env.RECEIPT_SHARE_LINK_DAYS = original;
  }
});

test('computeExpiresAt adds shareLinkDays() days to the given instant', () => {
  const original = process.env.RECEIPT_SHARE_LINK_DAYS;
  process.env.RECEIPT_SHARE_LINK_DAYS = '10';
  try {
    const now = new Date('2026-08-25T00:00:00.000Z');
    const expiresAt = computeExpiresAt(now);
    assert.strictEqual(expiresAt.toISOString(), '2026-09-04T00:00:00.000Z');
  } finally {
    if (original === undefined) delete process.env.RECEIPT_SHARE_LINK_DAYS;
    else process.env.RECEIPT_SHARE_LINK_DAYS = original;
  }
});

test('isShareLinkActive is false for no link at all', () => {
  assert.strictEqual(isShareLinkActive(null, new Date()), false);
  assert.strictEqual(isShareLinkActive(undefined, new Date()), false);
});

test('isShareLinkActive is false once revoked, even if not yet expired', () => {
  const now = new Date('2026-08-25T00:00:00.000Z');
  const link = { revokedAt: new Date('2026-08-24T00:00:00.000Z'), expiresAt: new Date('2026-10-24T00:00:00.000Z') };
  assert.strictEqual(isShareLinkActive(link, now), false);
});

test('isShareLinkActive is true before expiry, false at and after it', () => {
  const expiresAt = new Date('2026-08-25T12:00:00.000Z');
  const link = { revokedAt: null, expiresAt };
  assert.strictEqual(isShareLinkActive(link, new Date('2026-08-25T11:59:59.999Z')), true);
  assert.strictEqual(isShareLinkActive(link, expiresAt), false);
  assert.strictEqual(isShareLinkActive(link, new Date('2026-08-25T12:00:00.001Z')), false);
});
