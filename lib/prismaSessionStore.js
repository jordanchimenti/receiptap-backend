// lib/prismaSessionStore.js
// An express-session store backed by the app's existing Prisma client.
//
// Written rather than installed on purpose. Every off-the-shelf store
// (connect-pg-simple and friends) opens its OWN Postgres pool, and this app
// talks to Supabase's session-mode pooler, which caps at 15 clients for
// everything combined. Adding a second pool pushed past that cap: session
// writes began failing with EMAXCONNSESSION, and because express-session
// treats a store error on save as non-fatal, login broke silently -- the
// redirect succeeded, the cookie was set, and the session was never stored.
//
// Sharing Prisma's pool means sessions cost zero additional connections.
const session = require('express-session');
const prisma = require('./prisma');

const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly is plenty; rows are tiny

class PrismaSessionStore extends session.Store {
  constructor({ ttlMs }) {
    super();
    this.ttlMs = ttlMs;
    // unref so a pending timer never keeps the process alive on shutdown
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    if (this.pruneTimer.unref) this.pruneTimer.unref();
  }

  // Cookie-driven when express-session knows the expiry, falling back to the
  // configured TTL -- so a session can't be resurrected past its cookie.
  expiryFor(sess) {
    const cookieExpiry = sess?.cookie?.expires;
    if (cookieExpiry) return new Date(cookieExpiry);
    return new Date(Date.now() + this.ttlMs);
  }

  async get(sid, cb) {
    try {
      const row = await prisma.session.findUnique({ where: { sid } });
      // Expired rows are treated as absent even before the pruner reaches
      // them, so a stale row can never log someone back in.
      if (!row || row.expiresAt <= new Date()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (err) {
      cb(err);
    }
  }

  async set(sid, sess, cb) {
    try {
      const data = JSON.stringify(sess);
      const expiresAt = this.expiryFor(sess);
      await prisma.session.upsert({
        where: { sid },
        update: { data, expiresAt },
        create: { sid, data, expiresAt },
      });
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  async destroy(sid, cb) {
    try {
      await prisma.session.deleteMany({ where: { sid } });
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  // Called on every request for an existing session when `resave: false`.
  // Only the expiry moves, so a rolling session doesn't rewrite its payload.
  async touch(sid, sess, cb) {
    try {
      await prisma.session.updateMany({
        where: { sid },
        data: { expiresAt: this.expiryFor(sess) },
      });
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  async prune() {
    try {
      await prisma.session.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    } catch (err) {
      console.error('[sessionStore] prune failed:', err.message);
    }
  }
}

module.exports = { PrismaSessionStore };
