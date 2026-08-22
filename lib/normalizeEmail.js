// lib/normalizeEmail.js
// Email is the unique key on Merchant, Affiliate, and Customer, and Postgres
// string equality is case-sensitive -- so "Jordan@x.com" and "jordan@x.com"
// are two different rows to findUnique(), even though they're one mailbox to
// the person typing.
//
// This bit us for real: the OAuth paths (Google/Apple/Microsoft) already
// lowercased before writing, so accounts created that way are stored
// lowercase. The password login form looked the address up exactly as typed,
// so signing in with the same address capitalized the way your mail client
// shows it missed the row entirely and returned "Invalid email or password"
// -- indistinguishable from a wrong password, with a perfectly good one.
//
// Trim as well: a trailing space from mobile autocorrect or a copy/paste is
// the same silent failure with an even less visible cause.
//
// Use this on EVERY email lookup and on every write, so the two can't drift.
function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : email;
}

module.exports = { normalizeEmail };
