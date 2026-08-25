// routes/webhooks.js
// One shared endpoint per POS provider — handles every merchant on that provider.
// This is what makes the receipt route possible: it's where line items/totals
// actually get saved, before the customer ever taps.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const prisma = require('../lib/prisma');
const { claimAwaitingPuck } = require('../lib/pairPuck');
const { hashIdentifier } = require('../lib/hashIdentifier');
const { autoSaveReceiptForKnownShopper } = require('../services/receiptAutoSave');
const { awardLoyaltyStamps } = require('./loyalty');
const { categorizeInBackground } = require('../services/categorize-receipt');
const { buildSellerSnapshot } = require('../lib/receiptSnapshot');

// The email a POS attached to a sale, if any. Only ever used as a lookup key
// against an identifier the shopper recorded themselves -- never stored, and
// an unrecognised address links nothing. Shapes differ per provider, so each
// is read defensively and absence is the normal case.
function posCustomerEmailFrom(provider, payload) {
  try {
    if (provider === 'clover') {
      const c = payload?.customers?.elements?.[0];
      return c?.emailAddresses?.elements?.[0]?.emailAddress || null;
    }
    if (provider === 'shopify') {
      return payload?.customer?.email || payload?.email || null;
    }
    if (provider === 'lightspeed') {
      return payload?.customer?.email || payload?.customer_email || null;
    }
  } catch {
    return null;
  }
  return null;
}

// POS payloads report cash amounts inconsistently (Square in cents, Clover in
// cents, some fields absent entirely). Normalises to an integer number of
// cents, or null -- never 0, which would render as a real "$0.00 change" line.
function toCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}
const { fetchOrder } = require('../services/squareService');
const { fetchOrder: fetchCloverOrder, getValidAccessToken: getValidCloverAccessToken } = require('../services/cloverService');
const {
  fetchSale: fetchLightspeedSale,
  getValidAccessToken: getValidLightspeedAccessToken,
  verifyLightspeedSignature,
} = require('../services/lightspeedService');
const { verifyShopifyWebhook } = require('../services/shopifyService');
const { deleteShopperByEmail, purgeShopifyShopData } = require('../services/dataRetentionService');

const CLAIM_WINDOW_MS = 3 * 60 * 1000; // how long a puck shows the live receipt before reverting

// Mounted with express.raw() in server.js (before the global express.json()),
// so req.body arrives here as the untouched raw Buffer Square actually signed —
// re-serializing an already-parsed object wouldn't byte-for-byte match it.
router.post('/webhooks/pos/square', async (req, res) => {
  if (!verifySquareSignature(req)) return res.sendStatus(401);

  try {
    const body = JSON.parse(req.body.toString('utf8'));

    // Square also sends order.created/order.updated and payment.created for
    // the same sale -- payment.updated reaching COMPLETED is the one moment
    // it's actually finalized. Acknowledge everything else without acting on it.
    if (body.type !== 'payment.updated') return res.sendStatus(200);

    const payment = body.data.object.payment;
    if (payment.status !== 'COMPLETED') return res.sendStatus(200);

    const merchant = await prisma.merchant.findFirst({
      where: { squareMerchantId: body.merchant_id },
      include: { receiptTheme: true },
    });
    if (!merchant) return res.sendStatus(404); // event from a Square account we don't recognize

    // Square retries webhook delivery and sends multiple event types per
    // sale -- if this payment is already saved, just acknowledge and stop
    // rather than hitting Transaction.id's unique constraint.
    const existing = await prisma.transaction.findUnique({ where: { id: payment.id } });
    if (existing) return res.sendStatus(200);

    // Payments carry no line items or tax breakdown -- fetch the real order.
    const order = await fetchOrder(merchant.squareAccessToken, payment.order_id);
    const lineItems = (order.line_items || []).map((li) => ({
      name: li.name,
      quantity: parseInt(li.quantity, 10),
      unitPrice: Number(li.base_price_money?.amount || 0),
      total: Number(li.total_money?.amount || 0),
    }));

    const locationId = payment.location_id;
    const deviceId = payment.device_details?.device_id || null; // present for Terminal API sales, absent for simple POS-app sales

    const transaction = await prisma.transaction.create({
      data: {
        id: payment.id,
        merchantId: merchant.id,
        posProvider: 'square',
        posLocationId: locationId,
        posDeviceId: deviceId,
        orderNumber: payment.order_id || null,
        // The receipt should show when the sale actually happened at the
        // register, not whenever this webhook happened to get processed --
        // those can differ under retry/latency. Square reports this directly.
        createdAt: new Date(payment.created_at),
        lineItems,
        // Square's Money type always carries its own currency alongside the
        // amount -- reliable, unlike Clover/Lightspeed below (see
        // lib/receiptSnapshot.js's header comment for why those two stay null).
        currency: order.total_money?.currency || null,
        ...buildSellerSnapshot(merchant),
        // Already net of any discount -- Square's total_money/total_tax_money
        // are computed post-discount, so discountTotal below is shown on the
        // receipt as an informational line, not subtracted a second time.
        subtotal: Number(order.total_money?.amount || 0) - Number(order.total_tax_money?.amount || 0),
        tax: Number(order.total_tax_money?.amount || 0),
        discountTotal: Number(order.total_discount_money?.amount || 0),
        total: Number(order.total_money?.amount || payment.total_money?.amount || 0),
        paymentMethod: payment.card_details?.card
          ? `${payment.card_details.card.card_brand} ••••${payment.card_details.card.last_4}`
          : null,
        // Square reports all of these directly on the Payment object. Optional
        // chaining throughout: a cash sale has no card_details, a card sale has
        // no cash_details, and either way the missing side stays null.
        cardBrand: payment.card_details?.card?.card_brand || null,
        cardLast4: payment.card_details?.card?.last_4 || null,
        // Square's fingerprint is a stable per-card id, consistent across this
        // application's locations. Hashed immediately -- the raw value is used
        // here and nowhere else. Absent on cash sales and on any other
        // platform, which is why the shopper-identity feature is Square-only
        // and everyone else keeps tapping. No shopper is linked at this point;
        // that only happens on explicit consent (routes/email-capture.js).
        cardFingerprintHash: hashIdentifier(payment.card_details?.card?.fingerprint),
        authCode: payment.card_details?.auth_result_code || null,
        amountTenderedCents: toCents(payment.cash_details?.buyer_supplied_money?.amount),
        changeDueCents: toCents(payment.cash_details?.change_back_money?.amount),
      },
    });

    // Card recognition: if this card belongs to a shopper who opted in, the
    // receipt joins their wallet now, with no tap. A match can only exist
    // where consent was given and hasn't been withdrawn -- see
    // services/receiptAutoSave.js. Non-Square sales and unrecognised cards
    // fall straight through and behave exactly as before.
    await autoSaveReceiptForKnownShopper(transaction, {
      onLinked: async ({ transaction: txn, shopper }) => {
        await awardLoyaltyStamps(txn, shopper.id);
        if (!txn.aiCategorizedAt) {
          categorizeInBackground(txn, merchant.businessName);
        }
      },
    });

    // Find which puck sits at this specific register.
    // Prefer device-level match (handles multiple lanes at one location).
    // Fall back to location-level match (fine for single-register merchants,
    // or Square POS-app sales that don't report a device_id).
    let puck = null;
    if (deviceId) {
      puck = await prisma.puck.findFirst({
        where: { merchantId: merchant.id, posDeviceId: deviceId },
      });
    }
    if (!puck) {
      puck = await prisma.puck.findFirst({
        where: { merchantId: merchant.id, posLocationId: locationId, posDeviceId: null },
      });
    }

    // Nothing mapped to this register yet -- but a puck may be sitting in
    // tap-to-pair, waiting for exactly this sale to tell it where it lives.
    // See lib/pairPuck.js.
    if (!puck) {
      puck = await claimAwaitingPuck(prisma, merchant.id, transaction);
    }

    if (puck) {
      await prisma.puck.update({
        where: { id: puck.id },
        data: {
          currentTransactionId: transaction.id,
          transactionExpiresAt: new Date(Date.now() + CLAIM_WINDOW_MS),
        },
      });
    }
    // If no puck is mapped to this location and none was waiting to pair, the
    // transaction is still saved — it just won't be reachable by tap yet.

    res.sendStatus(200);
  } catch (err) {
    console.error('Error processing Square webhook:', err);
    res.sendStatus(500); // tells Square to retry
  }
});

// Square's documented scheme: HMAC-SHA256 of (notification URL + raw body),
// base64-encoded, compared against the x-square-hmacsha256-signature header.
// SQUARE_WEBHOOK_URL must exactly match the Notification URL configured on
// the subscription in the Developer Dashboard — Square signs against that
// literal string, not whatever the request happens to arrive as.
function verifySquareSignature(req) {
  const signature = req.headers['x-square-hmacsha256-signature'];
  const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  const notificationUrl = process.env.SQUARE_WEBHOOK_URL;

  if (!signature || !signatureKey || !notificationUrl || !Buffer.isBuffer(req.body)) return false;

  const expectedSignature = crypto
    .createHmac('sha256', signatureKey)
    .update(notificationUrl + req.body.toString('utf8'))
    .digest('base64');

  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

// ---------------------------------------------------------------------------
// Clover: registered once in the Developer Dashboard (not created via an API
// call like Square's subscription), so this endpoint has to also handle the
// one-time verification handshake Clover does when the URL is first saved.
// Ongoing notifications carry no order data -- just which merchant and which
// object changed -- so every event means "go fetch the real thing."
// ---------------------------------------------------------------------------
router.post('/webhooks/pos/clover', async (req, res) => {
  const body = req.body;

  // One-time handshake: Clover POSTs this the moment the webhook URL is
  // saved in the Developer Dashboard. Log it -- the founder copies it back
  // into the dashboard's Webhooks section to confirm ownership of this URL.
  if (body.verificationCode) {
    console.log(`[clover webhook] Verification code (paste into Developer Dashboard > Webhooks): ${body.verificationCode}`);
    return res.sendStatus(200);
  }

  if (!verifyCloverAuth(req)) return res.sendStatus(401);

  try {
    const merchantEvents = body.merchants || {};
    for (const [cloverMerchantId, events] of Object.entries(merchantEvents)) {
      for (const event of events) {
        // Only orders represent a sale -- object IDs are prefixed with their
        // type ("O:" orders, "P:" payments, "I:" inventory, ...).
        if (!event.objectId || !event.objectId.startsWith('O:')) continue;
        await handleCloverOrderEvent(cloverMerchantId, event.objectId.slice(2));
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Error processing Clover webhook:', err);
    res.sendStatus(500); // tells Clover to retry
  }
});

async function handleCloverOrderEvent(cloverMerchantId, orderId) {
  const merchant = await prisma.merchant.findFirst({
    where: { cloverMerchantId },
    include: { receiptTheme: true },
  });
  if (!merchant) return; // event from a Clover account we don't recognize

  const accessToken = await getValidCloverAccessToken(merchant);
  const order = await fetchCloverOrder(accessToken, cloverMerchantId, orderId);

  // OPEN | PAID | REFUNDED | CREDITED | PARTIALLY_PAID | PARTIALLY_REFUNDED --
  // only a fully completed sale should generate a receipt. An order can fire
  // several CREATE/UPDATE events while it's being built up before payment;
  // this re-checks the live order rather than trusting the event type.
  if (order.paymentState !== 'PAID') return;

  // Clover retries webhook delivery -- if this order is already saved, stop.
  const existing = await prisma.transaction.findUnique({ where: { id: order.id } });
  if (existing) return;

  // Best-effort field mapping -- Clover line items don't carry an explicit
  // quantity the way Square's do (a "3x Coffee" sale is 3 separate line item
  // elements, not one with quantity: 3), so each element maps to one line at
  // quantity 1 unless unitQty (scaled items, e.g. deli-by-weight) says
  // otherwise. Verify this against a real sandbox sale before fully trusting it.
  const lineItemElements = order.lineItems?.elements || [];
  const lineItems = lineItemElements.map((li) => {
    const quantity = li.unitQty ? Math.max(1, Math.round(li.unitQty / 1000)) : 1;
    return {
      name: li.name,
      quantity,
      unitPrice: quantity > 1 ? Math.round(li.price / quantity) : li.price,
      total: li.price,
    };
  });

  const paymentElements = order.payments?.elements || [];
  const firstPayment = paymentElements[0];
  const cardTransaction = firstPayment?.cardTransaction;
  const paymentMethod = cardTransaction
    ? `${cardTransaction.cardType || 'Card'} ••••${cardTransaction.last4 || ''}`
    : null;
  // Clover puts card detail on the payment's cardTransaction, and cash
  // tendered/back on the payment itself. Both are best-effort in the same
  // sense as the tax/discount mapping above -- absent fields stay null
  // rather than being guessed at.
  const cardBrand = cardTransaction?.cardType || null;
  const cardLast4 = cardTransaction?.last4 || null;
  const authCode = cardTransaction?.authCode || null;
  const amountTenderedCents = toCents(firstPayment?.cashTendered);
  const changeDueCents = toCents(firstPayment?.cashBackAmount);

  // Best-effort -- each line item can carry its own `discounts` array;
  // exact field names haven't been verified against a real sandbox order yet
  // (see the mapping note above), so this defaults to 0 rather than guessing wrong.
  const discountTotal = lineItemElements.reduce((sum, li) => {
    const lineDiscounts = (li.discounts || []).reduce((s, d) => s + (d.amount || 0), 0);
    return sum + lineDiscounts;
  }, 0);

  // Clover doesn't expose a total_tax_money-equivalent on the order the way
  // Square does, so tax is inferred rather than reported directly: subtotal
  // is the real sum of line item prices, and tax is whatever's left once
  // that (minus discount) is subtracted from the order's real total. Still
  // best-effort -- confirm against a real sandbox sale -- but strictly more
  // accurate than the flat "tax: 0" this used to hardcode for every order.
  const lineItemsSubtotal = lineItemElements.reduce((sum, li) => sum + (li.price || 0), 0);
  const inferredTax = Math.max(0, order.total - lineItemsSubtotal + discountTotal);

  const transaction = await prisma.transaction.create({
    data: {
      id: order.id,
      merchantId: merchant.id,
      posProvider: 'clover',
      posLocationId: cloverMerchantId, // a Clover merchant IS the location
      posDeviceId: null,
      orderNumber: order.id,
      // Same reasoning as the Square handler -- createdTime is when Clover
      // recorded the sale, not whenever this webhook got processed.
      createdAt: new Date(order.createdTime),
      lineItems,
      subtotal: lineItemsSubtotal,
      tax: inferredTax,
      discountTotal,
      total: order.total,
      paymentMethod,
      cardBrand,
      cardLast4,
      authCode,
      amountTenderedCents,
      changeDueCents,
      // Clover's Order object has no confirmed per-order currency field in
      // this codebase (it's a merchant-account-level Clover setting this app
      // doesn't fetch) -- left null rather than guessed, same "verify before
      // trusting" discipline as the other best-effort fields above.
      currency: null,
      ...buildSellerSnapshot(merchant),
    },
  });

    // Recognition for a POS with no card identifier: if the till had a
    // customer attached, that address is matched against an EMAIL identifier
    // the shopper recorded from their own wallet. No customer, no match, no
    // change -- exactly as before.
    await autoSaveReceiptForKnownShopper(transaction, {
      posCustomerEmail: posCustomerEmailFrom('clover', order),
      onLinked: async ({ transaction: txn, shopper }) => {
        await awardLoyaltyStamps(txn, shopper.id);
        if (!txn.aiCategorizedAt) categorizeInBackground(txn, merchant.businessName);
      },
    });

  // A Clover connection is a single location -- no device-level lanes to
  // disambiguate between, unlike Square's multi-register handling.
  let puck = await prisma.puck.findFirst({
    where: { merchantId: merchant.id, posLocationId: cloverMerchantId, posDeviceId: null },
  });
  // Same tap-to-pair fallback as Square: a puck waiting to learn which
  // register it sits on is claimed by the first sale no other puck covers.
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
}

// Clover's X-Clover-Auth header carries a value shown in the Developer
// Dashboard's Webhooks section once configured -- set CLOVER_WEBHOOK_AUTH_TOKEN
// to that value.
//
// This used to accept ANY request when the token was unset, which was
// tolerable only because no Clover webhook was configured and the URL was
// therefore unreachable. The moment it is pointed at a public address, an
// unverified endpoint lets anyone who finds it POST fabricated sales into a
// merchant's account -- inventing receipts, filling loyalty cards, moving
// revenue figures. Square and Shopify both verify properly; this was the gap.
//
// So it now fails CLOSED in production: no token configured means no Clover
// webhook is accepted at all, which is the safe direction to be wrong in. In
// development it still passes through, so the flow stays testable without the
// real token.
function verifyCloverAuth(req) {
  const expected = process.env.CLOVER_WEBHOOK_AUTH_TOKEN;
  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      console.error(
        '[webhooks] REFUSED a Clover webhook: CLOVER_WEBHOOK_AUTH_TOKEN is not set. ' +
        'Set it to the value shown in Clover\'s Developer Dashboard > Webhooks, or ' +
        'no Clover sale can be accepted.'
      );
      return false;
    }
    return true;
  }
  const received = req.headers['x-clover-auth'];
  if (typeof received !== 'string' || received.length !== expected.length) return false;
  // Constant-time, same as every other secret comparison in this project.
  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

// ---------------------------------------------------------------------------
// Lightspeed Retail (X-Series). Field mapping below was corrected 2026-08-09
// against a REAL completed sale on a real trial store (see the git history
// for the original, doc-only-derived guesses this replaced) -- the original
// version silently dropped every sale because it checked `sale.status !==
// 'CLOSED'`, but the real field is `sale.state === 'closed'` (different
// name, different casing) -- a completely different field, not a typo fix.
// Line items also don't carry a product name inline -- only `product.id` --
// so this OAuth connection would need `products:read` scope (added to
// LIGHTSPEED_SCOPES going forward, but existing connections need to
// reconnect to actually be granted it) before names can resolve; falls back
// to a generic label rather than an extra API call per line item for now.
// ---------------------------------------------------------------------------
router.post('/webhooks/pos/lightspeed', async (req, res) => {
  if (!verifyLightspeedSignature(req)) return res.sendStatus(401);

  try {
    const body = JSON.parse(req.body.toString('utf8'));

    // Only a completed sale should generate a receipt -- ignore every other
    // event type this app hasn't asked to be notified about.
    if (body.type !== 'sale.update') return res.sendStatus(200);

    const domainPrefix = body.domain_prefix || body.retailer?.domain_prefix;
    const saleId = body.id || body.payload?.id || body.data?.id;
    if (!domainPrefix || !saleId) return res.sendStatus(200);

    const merchant = await prisma.merchant.findFirst({
      where: { lightspeedDomainPrefix: domainPrefix },
      include: { receiptTheme: true },
    });
    if (!merchant) return res.sendStatus(404); // event from a Lightspeed retailer we don't recognize

    // Lightspeed retries webhook delivery, and sale.update can fire more
    // than once for one sale (layby/account sales) -- if this sale is
    // already saved, just acknowledge and stop.
    const existing = await prisma.transaction.findUnique({ where: { id: saleId } });
    if (existing) return res.sendStatus(200);

    const accessToken = await getValidLightspeedAccessToken(merchant);
    const sale = await fetchLightspeedSale(domainPrefix, accessToken, saleId);

    if (sale.state !== 'closed') return res.sendStatus(200);

    // Real shape confirmed live: sale.line_items[], each with quantity,
    // product.id (no inline name -- see header comment), and
    // pricing.price/pricing.total in dollars.
    const lineItems = (sale.line_items || []).map((li) => ({
      name: 'Item', // product.id only -- see header comment on products:read
      quantity: Number(li.quantity) || 1,
      unitPrice: Math.round(Number(li.pricing?.price || 0) * 100),
      total: Math.round(Number(li.pricing?.total || 0) * 100),
    }));

    // Real shape confirmed live: sale.totals.price (pre-tax),
    // sale.totals.tax, sale.totals.price_incl_tax (post-tax total) -- all
    // in dollars.
    const subtotal = Math.round(Number(sale.totals?.price || 0) * 100);
    const tax = Math.round(Number(sale.totals?.tax || 0) * 100);
    const total = Math.round(Number(sale.totals?.price_incl_tax || 0) * 100);

    const transaction = await prisma.transaction.create({
      data: {
        id: saleId,
        merchantId: merchant.id,
        posProvider: 'lightspeed',
        // The retailer goes in the LOCATION field and the register in the
        // DEVICE field, mirroring Square. These were the other way round: the
        // register id was written as the location, while the puck lookup below
        // only ever searched for domainPrefix -- so a register id could never
        // match anything, and a puck paired against such a sale would store an
        // id nothing looks for and silently receive no receipts.
        posLocationId: domainPrefix,
        posDeviceId: sale.source?.register_id || sale.source?.outlet_id || null,
        orderNumber: sale.invoice_number || sale.receipt_number || null,
        createdAt: sale.date ? new Date(sale.date) : new Date(),
        lineItems,
        subtotal,
        tax,
        discountTotal: 0,
        total,
        // sale.payments was an empty array on a real confirmed Cash sale --
        // genuinely no payment-method data available from this endpoint as
        // observed, not a mapping guess. The card/auth/tender columns are
        // left unset for the same reason; the receipt simply omits them.
        paymentMethod: null,
        // No currency field confirmed anywhere on the Sale object this app
        // fetches (same "don't guess" reasoning as Clover, above).
        currency: null,
        ...buildSellerSnapshot(merchant),
      },
    });

    // Recognition for a POS with no card identifier: if the till had a
    // customer attached, that address is matched against an EMAIL identifier
    // the shopper recorded from their own wallet. No customer, no match, no
    // change -- exactly as before.
    await autoSaveReceiptForKnownShopper(transaction, {
      posCustomerEmail: posCustomerEmailFrom('lightspeed', sale),
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

    res.sendStatus(200);
  } catch (err) {
    console.error('Error processing Lightspeed webhook:', err);
    res.sendStatus(500); // tells Lightspeed to retry
  }
});

// ---------------------------------------------------------------------------
// Shopify POS. Only the orders/paid topic is subscribed to (see
// oauth-shopify.js), so every request here already represents a completed
// payment -- no separate "is this actually paid" check needed the way
// Square/Clover's handlers have to make one. source_name is checked instead
// to filter OUT online-storefront orders: this app only wants in-person
// register sales, and a shop can generate both from one connection.
// ---------------------------------------------------------------------------
router.post('/webhooks/pos/shopify', async (req, res) => {
  if (!verifyShopifyWebhook(req)) return res.sendStatus(401);

  try {
    const order = JSON.parse(req.body.toString('utf8'));

    // "pos" is Shopify's own source_name value for a Shopify POS (in-person)
    // sale -- "web", "mobile_app", etc. are online-channel orders this app
    // has no use for.
    if (order.source_name !== 'pos') return res.sendStatus(200);

    const shopDomain = req.headers['x-shopify-shop-domain'];
    if (!shopDomain) return res.sendStatus(200);

    const merchant = await prisma.merchant.findFirst({
      where: { shopifyShopDomain: shopDomain },
      include: { receiptTheme: true },
    });
    if (!merchant) return res.sendStatus(404); // event from a shop we don't recognize

    const transactionId = String(order.id);

    // Shopify retries webhook delivery -- if this order is already saved,
    // just acknowledge and stop.
    const existing = await prisma.transaction.findUnique({ where: { id: transactionId } });
    if (existing) return res.sendStatus(200);

    // Money fields are decimal strings in the shop's currency (e.g. "9.99"),
    // not cents -- convert here like every other provider's handler does.
    const lineItems = (order.line_items || []).map((li) => {
      const quantity = Number(li.quantity) || 1;
      const unitPrice = Math.round(Number(li.price || 0) * 100);
      return {
        name: li.name || li.title,
        quantity,
        unitPrice,
        total: unitPrice * quantity,
      };
    });

    const subtotal = Math.round(Number(order.subtotal_price || 0) * 100);
    const tax = Math.round(Number(order.total_tax || 0) * 100);
    const total = Math.round(Number(order.total_price || 0) * 100);
    const discountTotal = Math.round(Number(order.total_discounts || 0) * 100);

    const transaction = await prisma.transaction.create({
      data: {
        id: transactionId,
        merchantId: merchant.id,
        posProvider: 'shopify',
        // A Shopify connection is treated as one location for now -- see
        // oauth-shopify.js's assign-shopify comment.
        posLocationId: shopDomain,
        posDeviceId: null,
        orderNumber: order.name || (order.order_number ? String(order.order_number) : null),
        createdAt: order.created_at ? new Date(order.created_at) : new Date(),
        lineItems,
        subtotal,
        tax,
        discountTotal,
        total,
        paymentMethod: Array.isArray(order.payment_gateway_names) && order.payment_gateway_names.length
          ? order.payment_gateway_names[0]
          : null,
        // payment_details is present on orders paid by card and absent
        // otherwise, so this is read defensively. Shopify doesn't put an
        // approval code or cash tendered/change on the order payload at all
        // -- those live on the separate transactions resource, which this
        // webhook doesn't receive, so they stay null.
        cardBrand: order.payment_details?.credit_card_company || null,
        cardLast4: order.payment_details?.credit_card_last_four || null,
        // A standard top-level field on every Shopify order -- reliable,
        // unlike Clover/Lightspeed above.
        currency: order.currency || null,
        ...buildSellerSnapshot(merchant),
      },
    });

    // Recognition for a POS with no card identifier: if the till had a
    // customer attached, that address is matched against an EMAIL identifier
    // the shopper recorded from their own wallet. No customer, no match, no
    // change -- exactly as before.
    await autoSaveReceiptForKnownShopper(transaction, {
      posCustomerEmail: posCustomerEmailFrom('shopify', order),
      onLinked: async ({ transaction: txn, shopper }) => {
        await awardLoyaltyStamps(txn, shopper.id);
        if (!txn.aiCategorizedAt) categorizeInBackground(txn, merchant.businessName);
      },
    });

    let puck = await prisma.puck.findFirst({
      where: { merchantId: merchant.id, posLocationId: shopDomain, posDeviceId: null },
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

    res.sendStatus(200);
  } catch (err) {
    console.error('Error processing Shopify webhook:', err);
    res.sendStatus(500); // tells Shopify to retry
  }
});

// ---------------------------------------------------------------------------
// Shopify's three mandatory compliance webhooks -- required before the app
// can be submitted for App Store review, regardless of whether it's ever
// actually used. Unlike orders/paid (registered per-shop via API call in
// oauth-shopify.js), compliance topics are declared ONCE in
// shopify.app.toml's [[webhooks.subscriptions]] and Shopify requires all
// three to share a single URI -- confirmed against shopify.dev's own
// config docs, which show one `compliance_topics` array per `uri`, not one
// URI per topic. So this is ONE route, not three, dispatched by the
// X-Shopify-Topic header. Nested under /webhooks/pos/shopify to inherit
// that path's express.raw() mount in server.js. These fire for EVERY app on
// the platform whether or not this merchant is a customer, so an
// unrecognized shop is expected, not an error -- always 200 once the
// signature checks out, per Shopify's own docs.
// ---------------------------------------------------------------------------
router.post('/webhooks/pos/shopify/compliance', async (req, res) => {
  if (!verifyShopifyWebhook(req)) return res.sendStatus(401);

  try {
    const topic = req.headers['x-shopify-topic'];
    const payload = JSON.parse(req.body.toString('utf8'));
    const shopDomain = payload.shop_domain;

    if (topic === 'customers/data_request') {
      // A shop owner or customer asked what data this app holds about a
      // specific customer. No automated export exists yet -- this logs the
      // request with enough detail (shop, customer email, which orders) for
      // a human to fulfill it manually within Shopify's response window,
      // rather than pretending an automated pipeline is already built.
      console.log('[Shopify compliance] customers/data_request:', {
        shopDomain,
        customerEmail: payload.customer?.email,
        ordersRequested: payload.orders_requested,
      });
    } else if (topic === 'customers/redact') {
      // A customer asked to have their data erased (or the shop owner did
      // on their behalf). Scoped to this one shop, same as the
      // merchant-triggered dashboard deletion -- deleteShopperByEmail() is
      // the exact right primitive already, not deleteShopperEverywhere(),
      // since Shopify has no authority over what this shopper did at a
      // merchant's other POS connections.
      const email = payload.customer?.email;
      const merchant = shopDomain
        ? await prisma.merchant.findUnique({ where: { shopifyShopDomain: shopDomain } })
        : null;
      if (merchant && email) {
        await deleteShopperByEmail(email, merchant.id, { dryRun: false });
      }
    } else if (topic === 'shop/redact') {
      // The shop itself uninstalled (or requested erasure) -- ReceipTap no
      // longer has authorization to hold ANY of that shop's data, not just
      // this customer's. purgeShopifyShopData() hard-deletes the
      // Transaction rows (Shopify's data, unlike a merchant's own
      // Square/Clover/Lightspeed sales) and clears the now-orphaned
      // connection, distinct from the dashboard's "Disconnect" button which
      // deliberately keeps past Transactions.
      if (shopDomain) {
        await purgeShopifyShopData(shopDomain, { dryRun: false });
      }
    } else {
      console.warn('[Shopify compliance] Unrecognized topic:', topic);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Error processing Shopify compliance webhook:', err);
    res.sendStatus(500);
  }
});

module.exports = router;
