// lib/prisma.js
// Single shared Prisma Client for the whole server process. Every route,
// middleware, and service should require this instead of creating its own
// `new PrismaClient()` -- each separate instance opens its own connection
// pool, and enough of them exhausts Supabase's session-pooler limit (15
// clients), which crashes the entire process, not just one request.
//
// That 15-client cap is also why the pool size is pinned here rather than
// left to Prisma's default (num_cpus * 2 + 1, which on a developer laptop is
// already most of the budget on its own). The session store keeps its own
// small pool alongside this one (server.js), so both have to fit inside 15.
// Symptom when they don't: pages that fan out several queries at once -- the
// wallet does ten -- hang instead of erroring, with EMAXCONNSESSION in the log.
const { PrismaClient } = require('@prisma/client');

const PRISMA_POOL_SIZE = 8;

function urlWithConnectionLimit(url) {
  if (!url || url.includes('connection_limit=')) return url;
  return url + (url.includes('?') ? '&' : '?') + `connection_limit=${PRISMA_POOL_SIZE}`;
}

module.exports = new PrismaClient({
  datasources: { db: { url: urlWithConnectionLimit(process.env.DATABASE_URL) } },
});
