// services/toastSaleSync.js
// Turns one already-fetched Toast Order into zero or more saved
// Transactions -- one per CLOSED check on the order, not one per order.
// Toast supports splitting a single order across multiple checks (e.g. one
// per guest at a table), each with its own items and payment, which is
// much closer to what "a receipt" means here than the order as a whole.
//
// Field names throughout are doc-derived (doc.toasttab.com/openapi/orders)
// and NOT yet verified against a real restaurant's live data -- there is no
// free, self-serve way to get real Toast Standard API credentials the way
// Lightspeed's free trial provided (a real restaurant on Toast RMS
// Essentials+, or Toast-granted sandbox access, is required). Treat this
// the way the very first version of lightspeedSaleSync.js was treated
// before a real sale proved (and corrected) some of its assumptions.
const prisma = require('../lib/prisma');
const { claimAwaitingPuck } = require('../lib/pairPuck');
const { autoSaveReceiptForKnownShopper } = require('./receiptAutoSave');
const { awardLoyaltyStamps } = require('../routes/loyalty');
const { categorizeInBackground } = require('./categorize-receipt');
const { buildSellerSnapshot } = require('../lib/receiptSnapshot');
const { currencyForCountry } = require('../lib/currencyForCountry');

const CLAIM_WINDOW_MS = 3 * 60 * 1000; // matches routes/webhooks.js's CLAIM_WINDOW_MS

// One check -> one Transaction (or null if this check isn't a real
// completed sale, or was already saved -- the poller can see the same
// check again across overlapping polling windows).
async function processToastCheck(merchant, restaurantGuid, order, check) {
  if (check.voided || check.deleted) return null;
  if (check.paymentStatus !== 'CLOSED') return null;

  const existing = await prisma.transaction.findUnique({ where: { id: check.guid } });
  if (existing) return null;

  // Real field names per Toast's schema: displayName (not "name"), price
  // already reflects any per-item discount (preDiscountPrice is the
  // pre-discount figure, kept only as a reference, not shown).
  const lineItems = (check.selections || [])
    .filter((s) => !s.voided && !s.deleted)
    .map((s) => ({
      name: s.displayName || 'Item',
      quantity: Number(s.quantity) || 1,
      unitPrice: Math.round((Number(s.price) || 0) / (Number(s.quantity) || 1) * 100),
      total: Math.round((Number(s.price) || 0) * 100),
    }));

  const total = Math.round((Number(check.totalAmount) || 0) * 100);
  const tax = Math.round((Number(check.taxAmount) || 0) * 100);
  const subtotal = total - tax;

  // Only a CREDIT payment carries card details -- same convention as
  // Square/Clover (services/squareService.js, routes/webhooks.js's Clover
  // handler): paymentMethod is a card-brand label or nothing, not a generic
  // "Cash" string. A check can have split tenders (partial cash, partial
  // card); the first payment found is treated as the primary one, matching
  // how amountTendered/changeDue below are also single-payment fields on
  // this app's schema, not arrays.
  const payments = check.payments || [];
  const cardPayment = payments.find((p) => p.type === 'CREDIT' && p.cardType);
  const cashPayment = payments.find((p) => p.type === 'CASH');

  const transaction = await prisma.transaction.create({
    data: {
      id: check.guid,
      merchantId: merchant.id,
      posProvider: 'toast',
      posLocationId: restaurantGuid,
      // Toast's Standard API exposes no register/workstation identifier on
      // an order -- same "one connection, one store" model as Lightspeed's
      // pucks, no device-level distinction to make.
      posDeviceId: null,
      orderNumber: order.guid,
      createdAt: order.openedDate ? new Date(order.openedDate) : new Date(),
      lineItems,
      subtotal,
      tax,
      discountTotal: 0,
      total,
      paymentMethod: cardPayment ? `${cardPayment.cardType} ••••${cardPayment.last4Digits || ''}` : null,
      cardBrand: cardPayment?.cardType || null,
      cardLast4: cardPayment?.last4Digits || null,
      amountTenderedCents: cashPayment ? Math.round(Number(cashPayment.amount) * 100) : null,
      // No change-due field on Toast's Payment object -- unlike Clover,
      // there's nothing to compute this from without guessing, so it's left
      // unset rather than assumed to be $0.
      changeDueCents: null,
      // No currency field documented anywhere on the Order/Check schema --
      // same country fallback as Clover/Lightspeed.
      currency: currencyForCountry(merchant.addressCountry),
      ...buildSellerSnapshot(merchant),
    },
  });

  // Recognition for a POS with no card identifier: check.customer carries a
  // real email directly (no separate lookup needed, unlike Lightspeed's
  // customer_id-only sale) -- matched against an EMAIL identifier the
  // shopper recorded from their own wallet. No customer, no match, no
  // change.
  await autoSaveReceiptForKnownShopper(transaction, {
    posCustomerEmail: check.customer?.email || null,
    onLinked: async ({ transaction: txn, shopper }) => {
      await awardLoyaltyStamps(txn, shopper.id);
      if (!txn.aiCategorizedAt) categorizeInBackground(txn, merchant.businessName);
    },
  });

  // A puck already assigned to this restaurant takes priority over claiming
  // an "awaiting next sale" one -- same order Lightspeed's handler uses.
  let puck = await prisma.puck.findFirst({
    where: { merchantId: merchant.id, posLocationId: restaurantGuid, posDeviceId: null },
  });
  if (!puck) puck = await claimAwaitingPuck(prisma, merchant.id, transaction);
  if (puck) {
    await prisma.puck.update({
      where: { id: puck.id },
      data: {
        currentTransactionId: transaction.id,
        transactionExpiresAt: new Date(Date.now() + CLAIM_WINDOW_MS),
      },
    });
  }

  return transaction;
}

// One order can hold several checks (split by guest, etc.) -- each is
// processed independently. Returns how many checks were newly saved, for
// the poller's own logging.
async function processToastOrder(merchant, restaurantGuid, order) {
  if (order.voided || order.deleted) return 0;

  let saved = 0;
  for (const check of order.checks || []) {
    try {
      const txn = await processToastCheck(merchant, restaurantGuid, order, check);
      if (txn) saved += 1;
    } catch (err) {
      console.error(`[toast] Failed to process check ${check.guid} on order ${order.guid}:`, err.message);
    }
  }
  return saved;
}

module.exports = { processToastOrder };
