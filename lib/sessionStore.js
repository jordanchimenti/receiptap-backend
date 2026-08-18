// lib/sessionStore.js
// Where login sessions are kept.
//
// express-session's DEFAULT store is an in-memory object. That's fine on a
// laptop and actively harmful on a real host: every deploy and every restart
// throws away the whole object, which logs out every merchant and every
// shopper at once, and nothing ever evicts old entries, so memory climbs
// until the process dies. express-session itself prints a warning about it.
//
// So sessions live in Postgres instead -- the same database everything else
// is already in, so there's no new service to run or pay for.
//
// NOTE ON THE CONNECTION POOL: this opens a SECOND pool alongside Prisma's,
// which is exactly the thing CLAUDE.md's "Prisma client" gotcha warns about
// (enough pools exhaust Supabase's session-pooler limit and take down the
// whole process, not just one request). It's unavoidable here -- Prisma's
// pool isn't something connect-pg-simple can borrow -- so the damage is
// capped instead: max 3 connections, which is plenty for session
// reads/writes since each one is a single indexed lookup by session ID.
const pgSession = require('connect-pg-simple');
const { Pool } = require('pg');

function createSessionStore(session) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3, // deliberately small -- see the note above
  });

  // A dead session-store connection must never crash the process. Without
  // this handler, an idle client dropped by Supabase emits an 'error' event
  // with no listener, which Node treats as fatal. Logging it lets pg discard
  // that client and open a fresh one on the next request.
  pool.on('error', (err) => {
    console.error('[session-store] idle connection error (pool recovered):', err.message);
  });

  return new (pgSession(session))({
    pool,
    // Creates the "session" table on first boot if it isn't there yet, so
    // deploying doesn't need a manual SQL step. This table is deliberately
    // NOT in prisma/schema.prisma -- it belongs to connect-pg-simple, which
    // owns its own column layout. Prisma won't touch it, but `prisma
    // migrate dev` may mention it as an unexpected table when comparing the
    // database against the schema; that's expected, not drift to "fix."
    createTableIfMissing: true,
    // Sweep expired rows every 15 minutes. Without this, logged-out and
    // long-expired sessions accumulate in the table forever.
    pruneSessionInterval: 60 * 15,
  });
}

module.exports = { createSessionStore };
