// routes/emailWebhook.js
// Inbound Nylas webhook -- kept as its own file rather than added to
// routes/webhooks.js, since this payload shape, verification method, and
// downstream logic have nothing in common with the POS handlers there (see
// docs/CONSUMER_FLOW_AUDIT.md section 7's recommendation).
//
// Two request shapes land here, both from Nylas, neither from anything a
// customer's browser ever sends:
//
//   GET  -- the one-time endpoint-verification challenge Nylas sends when a
//           webhook subscription is created or reactivated. Must echo the
//           `challenge` query param back as the ENTIRE raw response body --
//           no JSON wrapper, no quotes -- within 10 seconds, or Nylas never
//           tries again for this endpoint.
//   POST -- a real event notification, signed with X-Nylas-Signature over
//           the raw body. Mounted with express.raw() in server.js, same
//           "raw body before express.json()" requirement every other
//           signature-verified webhook in this app already follows.
const express = require('express');
const router = express.Router();
const { verifyWebhookSignature } = require('../services/emailProviderService');
const { recordCandidateFromSummary } = require('../services/emailReceiptService');
const prisma = require('../lib/prisma');

router.get('/webhooks/email', (req, res) => {
  const challenge = req.query.challenge;
  if (!challenge) return res.status(400).send('Missing challenge');
  res.set('Content-Type', 'text/plain');
  res.status(200).send(String(challenge));
});

router.post('/webhooks/email', async (req, res) => {
  const signature = req.headers['x-nylas-signature'];

  let valid;
  try {
    valid = verifyWebhookSignature(req.body, signature);
  } catch (err) {
    console.error('[email webhook] signature verification errored:', err.message);
    return res.status(500).send('Webhook not configured');
  }
  if (!valid) {
    console.error('[email webhook] signature verification failed');
    return res.status(400).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    return res.status(400).send('Invalid payload');
  }

  // Acknowledge immediately regardless of what's inside -- per this file's
  // own header comment, all AI-call-bearing work happens later, in
  // services/emailReceiptPoller.js, never inside this request.
  res.status(200).json({ received: true });

  if (event.type !== 'message.created') return;

  const grantId = event.data?.object?.grant_id || event.grant_id;
  const messageSummary = event.data?.object;
  if (!grantId || !messageSummary?.id) return;

  try {
    const connection = await prisma.emailConnection.findUnique({ where: { grantId } });
    if (!connection || connection.status !== 'connected') return; // disconnected since this message was sent -- ignore
    await recordCandidateFromSummary(connection, messageSummary);
  } catch (err) {
    console.error('[email webhook] failed to record candidate:', err.message);
  }
});

module.exports = router;
