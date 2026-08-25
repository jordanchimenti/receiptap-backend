// test/generate-receipt-pdf.test.js
// The merchant's bulk PDF export (routes/pdf-export.js) broke silently after
// the receipt_seller_snapshot migration: receipt.ejs started requiring the
// caller to pass `seller`, and generate-receipt-pdf.js never did. 239 unit
// tests passed the whole time, because none of them actually rendered a
// receipt -- they tested the pure resolver function in isolation (see
// receipt-seller-snapshot.test.js), which is necessary but not sufficient.
// This test exercises the real thing: real Playwright, the real receipt.ejs
// template on disk, no mocking of the render path -- so a future refactor
// that silently drops a required template local fails a test immediately
// instead of only failing in production the next time someone downloads a
// bulk export.
//
// No database needed: generateReceiptPDFs takes already-fetched plain
// objects, never touches Prisma itself, so this runs against constructed
// fixtures shaped exactly like real rows -- fast enough for the normal test
// run, deterministic, and independent of whatever's in the dev database.

const test = require('node:test');
const assert = require('node:assert');

const { generateReceiptPDFs } = require('../services/generate-receipt-pdf');
const { buildSellerSnapshot } = require('../lib/receiptSnapshot');

const MERCHANT = {
  id: 'merchant_test',
  businessName: 'Real Coffee Co.',
  addressLine1: '1 Real St.',
  addressLine2: null,
  addressCity: 'Niagara Falls',
  addressRegion: 'ON',
  addressPostalCode: 'L2E 0A1',
  addressCountry: 'CA',
};

const THEME = {
  layoutId: 'classic',
  primaryColor: '#111111',
  accentColor: '#2563eb',
  displayName: null,
  logoUrl: null,
  headerText: 'Thanks for shopping with us!',
  footerText: null,
  gstHstNumber: '123456789 RT0001',
  taxNumberLabel: null,
  taxNumber2: null,
  taxNumber2Label: null,
  taxLabel: 'Tax',
  returnPolicy: null,
  showGoogleReview: false,
  showWarranty: false,
  showWalletSave: false,
  showPartnerProgram: false,
};

// Built the same way a real POS webhook handler would at creation time
// (lib/receiptSnapshot.js's buildSellerSnapshot), not hand-typed seller*
// fields -- so this fixture can't drift from what a real row actually looks
// like the way a hand-maintained one could.
const SELLER_SNAPSHOT = buildSellerSnapshot({ ...MERCHANT, receiptTheme: THEME });

const TRANSACTION = {
  id: 'txn_test_1',
  merchantId: MERCHANT.id,
  posProvider: 'square',
  posLocationId: 'loc_1',
  posDeviceId: null,
  orderNumber: 'ORD-1',
  lineItems: [{ name: 'Coffee', quantity: 1, unitPrice: 450, total: 450 }],
  subtotal: 450,
  tax: 59,
  discountTotal: 0,
  total: 509,
  paymentMethod: 'Visa ••••4242',
  cardBrand: 'Visa',
  cardLast4: '4242',
  authCode: null,
  amountTenderedCents: null,
  changeDueCents: null,
  createdAt: new Date('2026-07-01T12:00:00Z'),
  ...SELLER_SNAPSHOT,
};

test('the merchant bulk PDF export renders a real receipt end to end', async () => {
  const results = await generateReceiptPDFs([TRANSACTION], MERCHANT, THEME);

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].transactionId, TRANSACTION.id);
  // A real PDF starts with the %PDF- magic bytes -- proof this is an actual
  // rendered document, not an empty buffer from a swallowed error.
  assert.strictEqual(results[0].buffer.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(results[0].buffer.length > 1000, 'a real rendered receipt should be more than a placeholder-sized buffer');
});

test('a transaction missing its seller snapshot fails the export loudly, not silently', async () => {
  const brokenTransaction = { ...TRANSACTION };
  delete brokenTransaction.sellerName;

  // Must reject, not resolve with a wrong/blank PDF -- a silent fallback
  // here is exactly the live-join bug this migration exists to remove.
  await assert.rejects(
    () => generateReceiptPDFs([brokenTransaction], MERCHANT, THEME),
    /missing its seller snapshot/
  );
});
