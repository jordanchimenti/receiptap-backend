// services/emailReceiptPoller.js
// Same non-distributed setInterval pattern as services/lightspeedPoller.js
// and services/toastPoller.js -- see CLAUDE.md and
// docs/CONSUMER_FLOW_AUDIT.md section 7 for why no real job queue exists in
// this codebase and why extending this pattern is the deliberate choice for
// this feature rather than introducing Redis/BullMQ.
//
// Two jobs share this one poller, run back to back on the same tick:
//
//   1. Backfill discovery -- any EmailConnection that has never synced
//      (lastSyncedAt is null) gets its bounded 90-day history walked via
//      Nylas's listMessages, running the same cheap candidate filter
//      services/emailReceiptService.js's recordCandidateFromSummary()
//      already applies to live webhook events. This only DISCOVERS
//      candidates (writes 'pending' rows) -- it never classifies/extracts,
//      so a first connection with years of Square receipts can't block the
//      event loop with hundreds of AI calls in one tick.
//
//   2. Pending classification -- a small batch of 'pending'
//      ProcessedEmailMessage rows (from either the webhook or backfill
//      discovery above) get fetched in full and classified. This is the
//      only place in the whole feature that makes an AI call, and it's
//      capped per tick on purpose.
const prisma = require('../lib/prisma');
const { listMessages } = require('./emailProviderService');
const { recordCandidateFromSummary, processPendingMessage } = require('./emailReceiptService');

const BACKFILL_DAYS = 90;
const BACKFILL_PAGE_SIZE = 50;
const BACKFILL_MAX_PAGES_PER_TICK = 4; // bounds one tick's worth of discovery work per connection
const CLASSIFY_BATCH_SIZE = 10; // bounds one tick's worth of AI-call-bearing work, across ALL connections

async function runBackfillDiscovery() {
  const unsynced = await prisma.emailConnection.findMany({
    where: { status: 'connected', lastSyncedAt: null },
  });

  for (const connection of unsynced) {
    try {
      await backfillConnection(connection);
    } catch (err) {
      console.error(`[email poller] backfill failed for connection ${connection.id}:`, err.message);
    }
  }
}

async function backfillConnection(connection) {
  const receivedAfter = Math.floor((Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000) / 1000);
  let pageToken = null;
  let pagesFetched = 0;
  let candidatesFound = 0;

  do {
    const { messages, nextPageToken } = await listMessages(connection.grantId, {
      receivedAfter,
      pageToken,
      limit: BACKFILL_PAGE_SIZE,
    });
    for (const summary of messages) {
      const recorded = await recordCandidateFromSummary(connection, summary);
      if (recorded) candidatesFound += 1;
    }
    pageToken = nextPageToken;
    pagesFetched += 1;
  } while (pageToken && pagesFetched < BACKFILL_MAX_PAGES_PER_TICK);

  if (!pageToken) {
    // Reached the end of the 90-day window in this tick -- mark this
    // connection synced so it's never re-walked. A connection with more
    // than BACKFILL_MAX_PAGES_PER_TICK pages of history simply finishes
    // over several ticks instead of one; lastSyncedAt only gets set once
    // pageToken runs out, not after the first batch.
    await prisma.emailConnection.update({
      where: { id: connection.id },
      data: { lastSyncedAt: new Date() },
    });
  }

  if (candidatesFound > 0) {
    console.log(`[email poller] backfill found ${candidatesFound} candidate(s) for connection ${connection.id}`);
  }
}

async function runPendingClassification() {
  const pending = await prisma.processedEmailMessage.findMany({
    where: { status: 'pending' },
    take: CLASSIFY_BATCH_SIZE,
    orderBy: { processedAt: 'asc' },
    include: { emailConnection: true },
  });

  let created = 0;
  for (const row of pending) {
    try {
      const result = await processPendingMessage(row, row.emailConnection);
      if (result.created) created += 1;
    } catch (err) {
      // Left as 'pending' on a genuine failure (Nylas API error, DB
      // hiccup) -- the next tick retries it, same "leave it and retry"
      // reasoning as the Lightspeed/Toast pollers' per-item try/catch.
      console.error(`[email poller] failed to process message ${row.providerMessageId}:`, err.message);
    }
  }

  if (created > 0) {
    console.log(`[email poller] created ${created} receipt(s) this tick`);
  }
}

async function runEmailPoll() {
  await runBackfillDiscovery();
  await runPendingClassification();
}

module.exports = { runEmailPoll };
