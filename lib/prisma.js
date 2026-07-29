// lib/prisma.js
// Single shared Prisma Client for the whole server process. Every route,
// middleware, and service should require this instead of creating its own
// `new PrismaClient()` -- each separate instance opens its own connection
// pool, and enough of them exhausts Supabase's session-pooler limit (15
// clients), which crashes the entire process, not just one request.
const { PrismaClient } = require('@prisma/client');

module.exports = new PrismaClient();
