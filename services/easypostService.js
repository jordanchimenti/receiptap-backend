// services/easypostService.js
// Buys a real prepaid shipping label for a merchant returning their
// ReceipTap puck(s) -- the actual mechanism behind the Terms' "we'll email
// a prepaid return label" promise (Hardware section), which had nothing
// behind it before this (see docs/LEGAL_REVIEW_NOTES.md item 7's history).
//
// Guarded the same way Stripe/Resend are elsewhere in this app: a missing
// key must never throw at startup or take a cancellation down with it.
// Label generation is best-effort, not required -- see
// createReturnLabel()'s own doc comment for what happens when it fails.

const { RETURN_ADDRESS } = require('../config/entity');

let EasyPostClient = null;
try {
  EasyPostClient = require('@easypost/api');
} catch {
  // Package not installed yet in some environment -- isEasyPostConfigured()
  // already gates every real call, so this only matters if someone removes
  // the dependency without also removing EASYPOST_API_KEY.
}

const client = process.env.EASYPOST_API_KEY && EasyPostClient
  ? new EasyPostClient(process.env.EASYPOST_API_KEY)
  : null;

function isEasyPostConfigured() {
  return Boolean(client);
}

// A puck is a small, light plastic disc -- even several packed together
// with padding sit well under this. Estimated, not measured: EasyPost only
// needs a parcel to price a rate, and overestimating slightly costs a
// little more per label rather than producing a bad rate. Revisit if real
// return volume ever shows this is meaningfully off.
const RETURN_PARCEL = {
  length: 6, // inches
  width: 4,
  height: 2,
  weight: 4, // ounces
};

// The address fields a merchant fills in on Business Settings
// (prisma/schema.prisma's Merchant model) -- required to ship FROM. A
// merchant who never filled these in can't get a real label; the caller
// falls back to email-only instructions in that case, same as any other
// EasyPost failure.
function hasCompleteAddress(merchant) {
  return Boolean(
    merchant.addressLine1 && merchant.addressCity && merchant.addressRegion &&
    merchant.addressPostalCode && merchant.addressCountry
  );
}

// Shared by both directions below -- creates a shipment between two
// addresses, buys the cheapest real rate, and returns the label/tracking
// fields both callers need. Returns null on ANY failure (no rates, a
// rejected address, a carrier outage, whatever): callers must treat null as
// "this shipment doesn't have a label yet," never as something to throw
// over -- see createReturnLabel()'s and createOutboundLabel()'s own comments
// for what each does instead when this comes back null.
async function buyLabel({ toAddress, fromAddress, parcel, logContext }) {
  try {
    const shipment = await client.Shipment.create({ to_address: toAddress, from_address: fromAddress, parcel });

    if (!shipment.rates || shipment.rates.length === 0) {
      console.error(`[easypostService] no rates returned for ${logContext}`);
      return null;
    }

    // Cheapest real rate -- this is ReceipTap covering the cost of
    // hardware it still owns moving in either direction, not a service
    // being sold, so there's no reason to pick anything but the lowest
    // priced option that actually ships it.
    const lowestRate = shipment.rates.reduce((min, r) =>
      parseFloat(r.rate) < parseFloat(min.rate) ? r : min
    );

    const bought = await client.Shipment.buy(shipment.id, { rate: lowestRate });

    return {
      labelUrl: bought.postage_label?.label_url || null,
      trackingCode: bought.tracking_code || null,
      trackingUrl: bought.tracker?.public_url || null,
      trackerId: bought.tracker?.id || null,
    };
  } catch (err) {
    console.error(`[easypostService] label purchase failed for ${logContext}:`, err.message);
    return null;
  }
}

/**
 * Buys a real prepaid label shipping the merchant's puck(s) back to
 * ReceipTap's registered address. Returns
 * { labelUrl, trackingCode, trackingUrl, trackerId } on success, or null on
 * ANY failure -- not configured, incomplete merchant address, EasyPost
 * rejecting the address, a carrier outage, whatever. Callers must treat
 * null as "send the return-instructions email without a label attached,"
 * never as something to throw over -- a merchant who needs to return
 * hardware must still hear from us even when the label itself can't be
 * bought right now.
 */
async function createReturnLabel(merchant) {
  if (!isEasyPostConfigured()) return null;
  if (!hasCompleteAddress(merchant)) {
    console.warn(`[easypostService] merchant ${merchant.id} has no complete address on file -- skipping label`);
    return null;
  }

  return buyLabel({
    toAddress: RETURN_ADDRESS,
    fromAddress: {
      name: merchant.businessName,
      street1: merchant.addressLine1,
      street2: merchant.addressLine2 || undefined,
      city: merchant.addressCity,
      state: merchant.addressRegion,
      zip: merchant.addressPostalCode,
      country: merchant.addressCountry,
      phone: merchant.ownerPhone || undefined,
    },
    parcel: RETURN_PARCEL,
    logContext: `merchant ${merchant.id}'s return shipment`,
  });
}

/**
 * Buys a real prepaid label shipping a HardwareOrder's puck(s) OUT to the
 * merchant -- the reverse direction of createReturnLabel(). Returns the same
 * shape, null on any failure, same "never block" contract:
 * services/hardwareOrderService.js still confirms the order and emails the
 * merchant even when a label couldn't be bought, just without one attached.
 * `order` is a HardwareOrder row (its shipping* fields are the snapshot
 * taken at order time, not a live Merchant lookup -- see schema.prisma).
 */
async function createOutboundLabel(order) {
  if (!isEasyPostConfigured()) return null;

  return buyLabel({
    toAddress: {
      name: order.shippingName,
      street1: order.shippingStreet1,
      street2: order.shippingStreet2 || undefined,
      city: order.shippingCity,
      state: order.shippingRegion,
      zip: order.shippingPostalCode,
      country: order.shippingCountry,
      phone: order.shippingPhone || undefined,
    },
    fromAddress: RETURN_ADDRESS,
    // Same per-unit weight estimate as RETURN_PARCEL, scaled by quantity --
    // still just enough for EasyPost to price a rate, not a real measurement.
    parcel: { ...RETURN_PARCEL, weight: RETURN_PARCEL.weight * Math.max(1, order.quantity) },
    logContext: `hardware order ${order.orderNumber}`,
  });
}

// Live status lookup for a previously-bought label's tracker, used by
// services/hardwareOrderService.js's periodic in-flight-order refresh
// (there's no webhook wired up for this -- see that file's own comment for
// why polling was chosen instead). Returns EasyPost's own status string
// ("pre_transit", "in_transit", "out_for_delivery", "delivered",
// "return_to_sender", "failure", "cancelled", "error", "unknown") or null on
// any failure, same "never block" contract as everything else here.
async function getTrackerStatus(trackerId) {
  if (!isEasyPostConfigured() || !trackerId) return null;

  try {
    const tracker = await client.Tracker.retrieve(trackerId);
    return tracker.status || null;
  } catch (err) {
    console.error(`[easypostService] tracker lookup failed for ${trackerId}:`, err.message);
    return null;
  }
}

module.exports = {
  isEasyPostConfigured,
  hasCompleteAddress,
  createReturnLabel,
  createOutboundLabel,
  getTrackerStatus,
};
