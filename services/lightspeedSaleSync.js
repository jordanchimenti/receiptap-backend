// services/lightspeedSaleSync.js
// Turns one already-fetched Lightspeed Sale object into a saved Transaction,
// including product-name resolution, payment method, customer recognition,
// and puck assignment -- everything routes/webhooks.js's Lightspeed handler
// used to do inline. Shared with services/lightspeedPoller.js so the
// webhook path and the polling backstop can't drift onto two different
// ideas of how a sale becomes a receipt: Lightspeed's own docs say webhook
// delivery "cannot be guaranteed", so the poller exists specifically to
// catch what the webhook misses, and both have to treat a sale identically
// for that to actually work.
const prisma = require('../lib/prisma');
const { claimAwaitingPuck } = require('../lib/pairPuck');
const { autoSaveReceiptForKnownShopper } = require('./receiptAutoSave');
const { awardLoyaltyStamps } = require('../routes/loyalty');
const { categorizeInBackground } = require('./categorize-receipt');
const { buildSellerSnapshot } = require('../lib/receiptSnapshot');
const { currencyForCountry } = require('../lib/currencyForCountry');
const { fetchProduct: fetchLightspeedProduct, fetchCustomer: fetchLightspeedCustomer } = require('./lightspeedService');

const CLAIM_WINDOW_MS = 3 * 60 * 1000; // matches routes/webhooks.js's CLAIM_WINDOW_MS

// Returns the created Transaction, or null if the sale isn't a real
// completed sale (not closed) or was already saved (webhook and poller can
// both see the same sale -- whichever gets there first wins, silently).
async function processLightspeedSale(merchant, domainPrefix, accessToken, sale) {
  if (sale.state !== 'closed') return null;

  const existing = await prisma.transaction.findUnique({ where: { id: sale.id } });
  if (existing) return null;

  // One lookup per unique product on the sale, not one per line item -- a
  // sale with the same product in two line items (e.g. two different sizes
  // rung up separately) only needs its name resolved once. Each lookup is
  // independently best-effort: a missing scope (pre-reconnect merchant) or
  // a deleted/inaccessible product shouldn't take down the whole receipt,
  // just that one item's name.
  const productIds = [...new Set((sale.line_items || []).map((li) => li.product?.id).filter(Boolean))];
  const productNames = {};
  await Promise.all(productIds.map(async (id) => {
    try {
      const product = await fetchLightspeedProduct(domainPrefix, accessToken, id);
      if (product?.name) productNames[id] = product.name;
    } catch (err) {
      console.error(`[lightspeed] Failed to resolve product ${id}:`, err.message);
    }
  }));

  // Real shape confirmed live: sale.line_items[], each with quantity,
  // product.id, and pricing.price/pricing.total in dollars.
  const lineItems = (sale.line_items || []).map((li) => ({
    name: productNames[li.product?.id] || 'Item',
    quantity: Number(li.quantity) || 1,
    unitPrice: Math.round(Number(li.pricing?.price || 0) * 100),
    total: Math.round(Number(li.pricing?.total || 0) * 100),
  }));

  // Real shape confirmed live: sale.totals.price (pre-tax), sale.totals.tax,
  // sale.totals.price_incl_tax (post-tax total) -- all in dollars.
  const subtotal = Math.round(Number(sale.totals?.price || 0) * 100);
  const tax = Math.round(Number(sale.totals?.tax || 0) * 100);
  const total = Math.round(Number(sale.totals?.price_incl_tax || 0) * 100);

  const transaction = await prisma.transaction.create({
    data: {
      id: sale.id,
      merchantId: merchant.id,
      posProvider: 'lightspeed',
      // The retailer goes in the LOCATION field and the register in the
      // DEVICE field, mirroring Square.
      posLocationId: domainPrefix,
      posDeviceId: sale.source?.register_id || sale.source?.outlet_id || null,
      orderNumber: sale.invoice_number || sale.receipt_number || null,
      createdAt: sale.date ? new Date(sale.date) : new Date(),
      lineItems,
      subtotal,
      tax,
      discountTotal: 0,
      total,
      // sale.payments[].type.name is the payment type as the merchant named
      // it in their own Lightspeed account ("Cash", "Credit Card", whatever
      // they've configured) -- reads correctly whenever this array is
      // actually populated. Confirmed live, though, that a real Cash sale
      // returns payments: [] from Lightspeed's API even on the individual
      // sale endpoint (not just this list) -- a real gap in what Lightspeed
      // itself reports, not a field this app is failing to read. So this
      // stays null for at least the plain-Cash case; unconfirmed whether a
      // processor-backed payment (e.g. Lightspeed Payments) populates it.
      // Joined for a split-tender sale on the chance it ever is populated.
      // Unlike Square/Clover, X-Series' Payment object carries no card
      // brand/last-4 even when present -- only this type name -- so
      // cardBrand/cardLast4 stay unset for real, not from a mapping gap.
      paymentMethod: (sale.payments || []).map((p) => p.type?.name).filter(Boolean).join(' + ') || null,
      // No currency field confirmed anywhere on the Sale object -- same
      // country fallback as Clover.
      currency: currencyForCountry(merchant.addressCountry),
      ...buildSellerSnapshot(merchant),
    },
  });

  // Recognition for a POS with no card identifier: if the till had a
  // customer attached, that address is matched against an EMAIL identifier
  // the shopper recorded from their own wallet. Lightspeed only ever gives
  // customer_id on the sale itself (no email inline), so it's resolved with
  // one extra call here, best-effort like the product-name lookups above: a
  // missing scope or an inaccessible customer just means no match, not a
  // failure.
  let lightspeedCustomerEmail = null;
  if (sale.customer_id) {
    try {
      const customer = await fetchLightspeedCustomer(domainPrefix, accessToken, sale.customer_id);
      lightspeedCustomerEmail = customer?.email || null;
    } catch (err) {
      console.error(`[lightspeed] Failed to resolve customer ${sale.customer_id}:`, err.message);
    }
  }
  await autoSaveReceiptForKnownShopper(transaction, {
    posCustomerEmail: lightspeedCustomerEmail,
    onLinked: async ({ transaction: txn, shopper }) => {
      await awardLoyaltyStamps(txn, shopper.id);
      if (!txn.aiCategorizedAt) categorizeInBackground(txn, merchant.businessName);
    },
  });

  // Register first, then the retailer as a whole -- same two-step Square
  // uses. A puck assigned through the older dropdown holds domainPrefix with
  // no device, so it still matches on the second pass.
  let puck = null;
  if (transaction.posDeviceId) {
    puck = await prisma.puck.findFirst({
      where: { merchantId: merchant.id, posDeviceId: transaction.posDeviceId },
    });
  }
  if (!puck) {
    puck = await prisma.puck.findFirst({
      where: { merchantId: merchant.id, posLocationId: domainPrefix, posDeviceId: null },
    });
  }
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

module.exports = { processLightspeedSale };
