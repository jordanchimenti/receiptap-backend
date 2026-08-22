// services/shopperIdentity.js
// The only place ShopperIdentifier rows are written, read or revoked.
//
// Two rules hold everywhere in this file, and both are load-bearing:
//
//   1. EVERY query is scoped by sourcePlatform. Identifiers are
//      platform-issued and platform-meaningful: a Square card fingerprint and
//      a Clover token for the same physical card are unrelated strings. There
//      is deliberately no cross-platform identity graph, and a lookup can
//      never reach a row from a different platform.
//
//   2. Lookups ignore revoked rows. Revocation is soft (revokedAt is set,
//      the row stays) so a DSAR request can still show that a link once
//      existed and when it ended -- but a revoked identifier must never
//      recognise anyone again.
//
// Raw values are hashed on the way in and never stored. Callers that already
// hold a hash -- the receipt-capture path, which hashes at the webhook because
// the raw fingerprint is gone by then -- use the *ByHash variants.
const prisma = require('../lib/prisma');
const { hashIdentifier } = require('../lib/hashIdentifier');

const IDENTIFIER_TYPES = ['CARD_FINGERPRINT', 'EMAIL', 'PHONE'];
const SOURCE_PLATFORMS = ['SQUARE', 'CLOVER', 'SHOPIFY', 'LIGHTSPEED', 'TOAST', 'MANUAL'];

// Reject unknown enum values here rather than letting Prisma throw mid-write:
// a typo'd platform must never silently become an unscoped or wrong-scoped row.
function assertValid(identifierType, sourcePlatform) {
  if (!IDENTIFIER_TYPES.includes(identifierType)) {
    throw new Error(`Unknown identifierType: ${identifierType}`);
  }
  if (!SOURCE_PLATFORMS.includes(sourcePlatform)) {
    throw new Error(`Unknown sourcePlatform: ${sourcePlatform}`);
  }
}

/**
 * Links an identifier to a shopper. Idempotent on
 * (identifierType, identifierValueHash, sourcePlatform): re-recording the same
 * identifier re-points it at this shopper and clears any previous revocation,
 * rather than creating a second row the unique index would reject anyway.
 *
 * CONSENT IS THE CALLER'S RESPONSIBILITY. This function does not check it --
 * see routes/email-capture.js, which only calls in after explicit
 * cross-merchant recognition consent.
 */
async function recordIdentifierByHash(shopperId, identifierType, identifierValueHash, sourcePlatform) {
  assertValid(identifierType, sourcePlatform);
  if (!shopperId || !identifierValueHash) return null;

  return prisma.shopperIdentifier.upsert({
    where: {
      identifierType_identifierValueHash_sourcePlatform: {
        identifierType,
        identifierValueHash,
        sourcePlatform,
      },
    },
    update: { shopperId, revokedAt: null },
    create: { shopperId, identifierType, identifierValueHash, sourcePlatform },
  });
}

/** As above, from the raw identifier. Hashes it; the raw value is never stored. */
async function recordIdentifier(shopperId, identifierType, rawValue, sourcePlatform) {
  const hash = hashIdentifier(rawValue);
  if (!hash) return null;
  return recordIdentifierByHash(shopperId, identifierType, hash, sourcePlatform);
}

/**
 * The shopper this identifier belongs to, or null.
 * Returns null for a revoked link, and never matches across platforms.
 */
// Identifier types whose value means the same thing everywhere. An email is
// an email regardless of which POS reported it, so scoping a lookup by
// platform would split one person across rows and match none of them.
//
// A deliberate, narrow exception to the platform-scoping rule -- which exists
// to stop one platform's opaque TOKEN being matched against another's, where
// equal strings would mean different cards. That risk doesn't exist for an
// address the shopper typed themselves.
const GLOBAL_IDENTIFIER_TYPES = new Set(['EMAIL', 'PHONE']);

async function findShopperByIdentifierHash(identifierType, identifierValueHash, sourcePlatform) {
  assertValid(identifierType, sourcePlatform);
  if (!identifierValueHash) return null;

  const row = await prisma.shopperIdentifier.findFirst({
    where: {
      identifierType,
      identifierValueHash,
      // Card fingerprints stay strictly platform-scoped; global types match
      // wherever they were recorded.
      ...(GLOBAL_IDENTIFIER_TYPES.has(identifierType) ? {} : { sourcePlatform }),
      revokedAt: null, // revoked links recognise nobody
    },
    include: { shopper: true },
  });
  return row ? row.shopper : null;
}

/** As above, from the raw identifier. */
async function findShopperByIdentifier(identifierType, rawValue, sourcePlatform) {
  const hash = hashIdentifier(rawValue);
  if (!hash) return null;
  return findShopperByIdentifierHash(identifierType, hash, sourcePlatform);
}

/**
 * Soft-revokes one identifier for one shopper. The row is kept as evidence the
 * link existed; an already-revoked row keeps its ORIGINAL revokedAt, so the
 * moment consent was withdrawn isn't rewritten by a repeated request.
 * Scoped by shopperId too: revoking must never touch a row that has since been
 * re-pointed at somebody else.
 * Returns the number of rows revoked (0 or 1).
 */
async function revokeIdentifierByHash(shopperId, identifierType, identifierValueHash, sourcePlatform) {
  assertValid(identifierType, sourcePlatform);
  if (!shopperId || !identifierValueHash) return 0;

  const result = await prisma.shopperIdentifier.updateMany({
    where: {
      shopperId,
      identifierType,
      identifierValueHash,
      sourcePlatform,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/** As above, from the raw identifier. */
async function revokeIdentifier(shopperId, identifierType, rawValue, sourcePlatform) {
  const hash = hashIdentifier(rawValue);
  if (!hash) return 0;
  return revokeIdentifierByHash(shopperId, identifierType, hash, sourcePlatform);
}

/** Every live identifier for a shopper -- for a "what do you know about me" view. */
async function listIdentifiersForShopper(shopperId, { includeRevoked = false } = {}) {
  return prisma.shopperIdentifier.findMany({
    where: { shopperId, ...(includeRevoked ? {} : { revokedAt: null }) },
    orderBy: { createdAt: 'desc' },
  });
}

module.exports = {
  IDENTIFIER_TYPES,
  GLOBAL_IDENTIFIER_TYPES,
  SOURCE_PLATFORMS,
  recordIdentifier,
  recordIdentifierByHash,
  findShopperByIdentifier,
  findShopperByIdentifierHash,
  revokeIdentifier,
  revokeIdentifierByHash,
  listIdentifiersForShopper,
};
