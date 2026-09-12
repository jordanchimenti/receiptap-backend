// services/emailProviderService.js
// The EmailProvider abstraction docs/CONSUMER_FLOW_AUDIT.md calls for --
// everything else in this codebase (routes/customer-email-connect.js,
// routes/emailWebhook.js, services/emailReceiptService.js,
// services/emailReceiptPoller.js) talks to THIS file's exported functions,
// never to Nylas directly, so swapping providers later (Unipile, or a
// second one) means changing this one file, not every caller.
//
// Uses Nylas's REST API directly via fetch (no SDK dependency) -- same
// reasoning as services/paypalService.js: the surface area needed here
// (hosted auth, one token exchange, list/get messages, webhook signature
// verification) is small enough that a client library would add more
// weight than it saves.
//
// Nylas's whole reason for existing in this design (see
// docs/CONSUMER_FLOW_AUDIT.md section 5/10) is that it already holds
// Google's CASA certification for restricted Gmail scopes, so this app
// never runs its own restricted-scope OAuth consent screen. Nylas also
// holds the actual Google/Microsoft OAuth token and refreshes it on its
// own -- this app only ever stores Nylas's own `grant_id` reference
// (EmailConnection.grantId), never a raw Google/Microsoft token. That's why
// this file has no token-refresh job the way services/cloverService.js
// does for POS OAuth: there's nothing on this side to refresh. Nylas's own
// static API key (NYLAS_API_KEY) authenticates every call this app makes;
// only the one-time authorization-code-for-grant exchange is per-customer.
//
// Endpoint shapes verified against Nylas's current v3 docs
// (developer.nylas.com/docs/v3) as of this file's creation -- confirm
// against live docs again before shipping if this sits unused for long,
// since a hosted third party's API can change on its own schedule.

const NYLAS_API_BASE = process.env.NYLAS_API_BASE || 'https://api.us.nylas.com';

const configured = Boolean(process.env.NYLAS_CLIENT_ID && process.env.NYLAS_API_KEY);

function assertConfigured() {
  if (!configured) throw new Error('Nylas is not configured yet (missing NYLAS_CLIENT_ID/NYLAS_API_KEY).');
}

async function nylasFetch(path, options = {}) {
  assertConfigured();
  const res = await fetch(`${NYLAS_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.NYLAS_API_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `Nylas API error: ${res.status}`);
    err.status = res.status;
    err.nylasDetails = data;
    throw err;
  }
  return data;
}

/** Builds the hosted-authentication URL a customer is redirected to.
 * access_type=online, not offline -- Nylas holds and refreshes the
 * underlying provider token on its own regardless, this only controls
 * whether Nylas ALSO hands this app a short-lived access_token in the
 * token-exchange response, which nothing here uses (only grant_id matters,
 * see exchangeCodeForGrant). state carries the customerId through the
 * round trip the same way PayPal's tracking_id does in
 * services/paypalService.js's createPartnerReferral. */
function getAuthUrl({ customerId, redirectUri, provider }) {
  assertConfigured();
  const params = new URLSearchParams({
    client_id: process.env.NYLAS_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'online',
    state: customerId,
  });
  if (provider) params.set('provider', provider); // 'google' | 'microsoft' | omit to let Nylas's own picker show
  return `${NYLAS_API_BASE}/v3/connect/auth?${params.toString()}`;
}

/** Exchanges the authorization code Nylas's redirect carries back for a
 * grant. The only field this app persists from the response is grant_id
 * (EmailConnection.grantId) -- see this file's header comment for why. */
async function exchangeCodeForGrant(code, redirectUri) {
  assertConfigured();
  const res = await fetch(`${NYLAS_API_BASE}/v3/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.NYLAS_CLIENT_ID,
      client_secret: process.env.NYLAS_API_KEY,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.grant_id) {
    const err = new Error(data.message || `Nylas token exchange failed: ${res.status}`);
    err.status = res.status;
    err.nylasDetails = data;
    throw err;
  }
  return { grantId: data.grant_id };
}

/** Reads back the grant's own account info -- the closest Nylas equivalent
 * to Stripe's accounts.retrieve/PayPal's getSellerStatus "is this actually
 * healthy" check. A grant that 401s here is the re-auth signal
 * EmailConnection.status='error' should reflect; confirm the exact error
 * shape against live Nylas responses during Phase 1 testing (documented as
 * an open item in docs/CONSUMER_FLOW_AUDIT.md). */
async function getGrantStatus(grantId) {
  return nylasFetch(`/v3/grants/${encodeURIComponent(grantId)}`);
}

/** Revokes a grant -- the "one-tap disconnect" the spec requires. Stops
 * ingestion immediately; never deletes anything this app has already
 * stored (that's account deletion's job, not disconnect's -- see
 * services/dataRetentionService.js's existing convention of the same
 * distinction for Stripe/PayPal Connect). */
async function revokeGrant(grantId) {
  return nylasFetch(`/v3/grants/${encodeURIComponent(grantId)}`, { method: 'DELETE' });
}

/** Lists messages newer than `receivedAfter` (a Unix seconds timestamp),
 * paginated via Nylas's own page_token cursor. Used both by the live
 * webhook-driven poller (a small, recent window) and the bounded 90-day
 * backfill (a much larger receivedAfter window, chunked across many calls
 * by the caller -- see services/emailReceiptPoller.js). Deliberately does
 * NOT request full bodies by default; Nylas's list endpoint returns
 * enough (subject, from, snippet, has_attachment) for the first-pass
 * filter in services/emailReceiptService.js to run before ever fetching a
 * full body, per the spec's data-minimization requirement. */
async function listMessages(grantId, { receivedAfter, pageToken, limit = 50 } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (receivedAfter) params.set('received_after', String(receivedAfter));
  if (pageToken) params.set('page_token', pageToken);
  const data = await nylasFetch(`/v3/grants/${encodeURIComponent(grantId)}/messages?${params.toString()}`);
  return { messages: data.data || [], nextPageToken: data.next_cursor || null };
}

/** Fetches one message IN FULL (body, attachments) -- only ever called for
 * a candidate that already passed the first-pass filter on the
 * list-messages summary above. This is the "only fetch full bodies for
 * candidates that pass" boundary the spec's data-minimization requirement
 * is built around; nothing upstream of this call should ever request or
 * store a full message body. */
async function getMessage(grantId, messageId) {
  return nylasFetch(`/v3/grants/${encodeURIComponent(grantId)}/messages/${encodeURIComponent(messageId)}`);
}

/** Downloads one attachment's raw bytes -- a separate function from
 * nylasFetch's JSON wrapper above, since this endpoint returns a binary
 * stream (application/octet-stream), not a JSON body. Only ever called for
 * an attachment services/emailReceiptService.js has already decided is
 * worth keeping (a PDF, on a message that already passed classification)
 * -- never speculatively, per the same data-minimization boundary
 * getMessage itself sits behind. */
async function downloadAttachment(grantId, attachmentId, messageId) {
  assertConfigured();
  const params = new URLSearchParams({ message_id: messageId });
  const res = await fetch(
    `${NYLAS_API_BASE}/v3/grants/${encodeURIComponent(grantId)}/attachments/${encodeURIComponent(attachmentId)}/download?${params.toString()}`,
    { headers: { Authorization: `Bearer ${process.env.NYLAS_API_KEY}` } }
  );
  if (!res.ok) throw new Error(`Nylas attachment download failed: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/** One-off setup helper, not called at request time -- registers this
 * app's webhook URL with Nylas. Meant to be run once per environment (like
 * services/stripeService.js's registerApplePayDomain), not on every server
 * boot. trigger_types is deliberately just message.created: the spec only
 * needs to know about NEW messages, not read/starred/bounce events. */
async function createWebhookSubscription(webhookUrl, { description } = {}) {
  return nylasFetch('/v3/webhooks', {
    method: 'POST',
    body: JSON.stringify({
      trigger_types: ['message.created'],
      webhook_url: webhookUrl,
      description: description || 'ReceipTap consumer email receipt ingestion',
    }),
  });
}

/** Verifies the X-Nylas-Signature header against the RAW request body --
 * must be computed over the exact bytes Nylas sent, before any JSON
 * parsing or decompression touches it (Nylas's own docs specifically warn
 * that reformatting breaks this), same "raw body before express.json()"
 * requirement the existing Stripe/Square webhook routes already follow
 * (see server.js's express.raw() mounts). rawBody must be a Buffer or
 * string exactly as received. */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!process.env.NYLAS_WEBHOOK_SECRET) {
    throw new Error('Nylas is not configured yet (missing NYLAS_WEBHOOK_SECRET).');
  }
  if (!signatureHeader) return false;
  const crypto = require('crypto');
  const expected = crypto
    .createHmac('sha256', process.env.NYLAS_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const givenBuf = Buffer.from(String(signatureHeader), 'hex');
  if (expectedBuf.length !== givenBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, givenBuf);
}

module.exports = {
  configured,
  getAuthUrl,
  exchangeCodeForGrant,
  getGrantStatus,
  revokeGrant,
  listMessages,
  getMessage,
  downloadAttachment,
  createWebhookSubscription,
  verifyWebhookSignature,
};
