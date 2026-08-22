// lib/hashIdentifier.js
// One-way hash for every shopper identifier (Square card fingerprints today;
// email and phone are modelled but unused so far).
//
// Raw identifiers never reach the database. A Square fingerprint is a stable
// pointer to a real payment card, so storing it in the clear would turn a
// database copy into a way to follow a person between shops. Hashing keeps
// the only operation we actually need -- "have we seen this exact value
// before, on this platform" -- while making the stored value useless on its own.
//
// Normalises before hashing so a fingerprint that differs only by case or
// whitespace doesn't create a second, non-matching row.
const crypto = require('crypto');

function hashIdentifier(rawValue) {
  if (typeof rawValue !== 'string') return null;
  const normalized = rawValue.trim().toLowerCase();
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

module.exports = { hashIdentifier };
