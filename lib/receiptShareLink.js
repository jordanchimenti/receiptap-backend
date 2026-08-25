// lib/receiptShareLink.js
//
// A time-limited, unauthenticated link to one scanned receipt's photo -- for
// a shopper who wants to hand it to their accountant without either of them
// needing a ReceipTap login. Tapped receipts already have this (the public
// /receipt/:id page); scanned receipts don't, because the photo itself lives
// behind the private-bucket proxy built earlier (see lib/fileStorage.js).
//
// Same shape as the existing password-reset token (Customer.resetToken,
// routes/customer-account.js): a random value, high enough entropy that
// guessing it is not a real attack surface, stored as plaintext (not
// hashed) because -- like a reset token -- it has no meaning outside this
// app to protect if the database were ever read, and this app already has a
// working answer for exactly this shape of problem. Deliberately NOT the
// receipt's storage key (fileStorage's buildKey() output): the storage key's
// only job is naming a file in the bucket, not granting viewing rights, and
// conflating the two would mean rotating one forces rotating the other.

const crypto = require('crypto');

const DEFAULT_SHARE_LINK_DAYS = 60;

/** How long a freshly (re)generated link stays valid, in days. Tunable via
 * RECEIPT_SHARE_LINK_DAYS without a deploy -- read fresh each call, not
 * cached at module load, so an env change takes effect on the next request. */
function shareLinkDays() {
  const parsed = parseInt(process.env.RECEIPT_SHARE_LINK_DAYS, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SHARE_LINK_DAYS;
}

/** 256 bits from the CSPRNG -- the token's only defense against guessing is
 * this entropy, not the lookup method, so nothing here may derive it from
 * anything else (not the receipt id, not the storage key, not a timestamp). */
function generateShareToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** @param {Date} now */
function computeExpiresAt(now) {
  return new Date(now.getTime() + shareLinkDays() * 24 * 60 * 60 * 1000);
}

/**
 * True only for a link that still actually works -- neither revoked (an
 * explicit regenerate) nor past its expiry. Shared by the route that streams
 * the photo and the route that shows the shopper their current link, so the
 * two can never disagree about whether a given row still grants access.
 * @param {{ revokedAt: Date|null, expiresAt: Date }} link
 * @param {Date} now
 */
function isShareLinkActive(link, now) {
  if (!link) return false;
  if (link.revokedAt) return false;
  return link.expiresAt.getTime() > now.getTime();
}

module.exports = { shareLinkDays, generateShareToken, computeExpiresAt, isShareLinkActive };
