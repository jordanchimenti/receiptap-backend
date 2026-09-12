// routes/customer-email-connect.js
// Connect/disconnect an inbox for automatic email receipts -- a new file
// rather than appended to the already-2800-line routes/customer-account.js,
// same per-domain-file convention as routes/customer-payouts.js. Mirrors
// the Stripe Connect / PayPal Partner Referral start/return route shape
// already established there, adapted for Nylas's hosted-auth flow (no
// "create an account object first" step -- the auth URL is buildable
// directly from customerId + a redirect URI).
const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { getBaseUrl } = require('../lib/baseUrl');
const emailProvider = require('../services/emailProviderService');

function requireCustomerAuth(req, res, next) {
  if (!req.session?.customerId) {
    return res.redirect(`/account/login?redirect=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

// A customer can only have one CONNECTED inbox at a time in this phase
// (multiple simultaneous connections is a real future feature, not
// required for Phase 1's validation goal -- see
// docs/CONSUMER_FLOW_AUDIT.md). A prior disconnected connection is left in
// place as history, never deleted or reused.
router.get('/account/connect-email/start', requireCustomerAuth, async (req, res) => {
  try {
    const existing = await prisma.emailConnection.findFirst({
      where: { customerId: req.session.customerId, status: 'connected' },
    });
    if (existing) return res.redirect('/account/settings?email_already_connected=1');

    const baseUrl = getBaseUrl(req);
    const url = emailProvider.getAuthUrl({
      customerId: req.session.customerId,
      redirectUri: `${baseUrl}/account/connect-email/return`,
      provider: req.query.provider, // 'google' | 'microsoft' | undefined (Nylas's own picker)
    });
    res.redirect(url);
  } catch (err) {
    console.error('Email connect failed to start:', err.message);
    res.redirect('/account/settings?email_connect_error=1');
  }
});

router.get('/account/connect-email/return', requireCustomerAuth, async (req, res) => {
  // Nylas round-trips `state` exactly as sent -- see getAuthUrl's own
  // comment. Refusing a mismatch is the CSRF-safety half of this flow, same
  // reasoning any OAuth `state` parameter exists for.
  if (req.query.state && req.query.state !== req.session.customerId) {
    return res.redirect('/account/settings?email_connect_error=1');
  }
  if (req.query.error || !req.query.code) {
    return res.redirect('/account/settings?email_connect_error=1');
  }

  try {
    const baseUrl = getBaseUrl(req);
    const { grantId } = await emailProvider.exchangeCodeForGrant(
      req.query.code,
      `${baseUrl}/account/connect-email/return`
    );
    const grantStatus = await emailProvider.getGrantStatus(grantId);

    await prisma.emailConnection.create({
      data: {
        customerId: req.session.customerId,
        provider: 'nylas',
        providerAccountId: grantStatus.email || grantStatus.id || grantId,
        grantId,
        status: 'connected',
      },
    });

    res.redirect('/account/settings?email_connected=1');
  } catch (err) {
    console.error('Email connect return failed:', err.message);
    res.redirect('/account/settings?email_connect_error=1');
  }
});

// One-tap disconnect -- revokes the grant (stops ingestion) but never
// deletes anything already stored (existing ScannedReceipt/
// ScannedReceiptSourceDocument rows survive) -- account deletion is the
// only thing that removes data, matching the existing convention for
// Stripe/PayPal Connect disconnection and the spec's explicit requirement.
router.post('/account/connect-email/disconnect', requireCustomerAuth, async (req, res) => {
  try {
    const connection = await prisma.emailConnection.findFirst({
      where: { customerId: req.session.customerId, status: 'connected' },
    });
    if (!connection) return res.redirect('/account/settings');

    try {
      await emailProvider.revokeGrant(connection.grantId);
    } catch (err) {
      // Revoking on Nylas's side failing (e.g. already revoked by the
      // customer directly with Google) must not block marking our own
      // record disconnected -- ingestion is gated on OUR status field,
      // not on Nylas still recognizing the grant.
      console.error('Nylas grant revoke failed (continuing to mark disconnected):', err.message);
    }

    await prisma.emailConnection.update({
      where: { id: connection.id },
      data: { status: 'disconnected', disconnectedAt: new Date() },
    });

    res.redirect('/account/settings?email_disconnected=1');
  } catch (err) {
    console.error('Email disconnect failed:', err.message);
    res.redirect('/account/settings?email_connect_error=1');
  }
});

module.exports = router;
