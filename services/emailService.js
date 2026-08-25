// services/emailService.js
// Transactional email: password resets, address verification, and the
// "your stamp card is full" note (see services/notificationService.js).
// Guarded the same way Stripe is (see services/stripeService.js) -- an empty
// API key must never throw at startup and take the whole server down.

const { Resend } = require('resend');
const { getAppUrl } = require('../lib/baseUrl');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// resend.dev's shared sandbox sender works with zero setup (no domain
// verification needed) -- fine for now, swap in a verified "from" address
// on your own domain once RESEND_FROM_EMAIL is set for that.
const FROM_ADDRESS = process.env.RESEND_FROM_EMAIL || 'ReceipTap <onboarding@resend.dev>';

// Every email this app sends has to answer "what do I do now?" with a link,
// not a description of where to look. The stamp-card email used to say "open
// it in your wallet under My Rewards" and stop there -- a reader on a phone
// then had to leave the email, find the app, and navigate to a page by name.
// A button costs nothing and removes the whole detour.
//
// Returns '' when APP_BASE_URL isn't configured: no button at all is better
// than one pointing at localhost, which looks real until it's tapped.
function actionButton(path, label) {
  const url = getAppUrl(path);
  if (!url) return '';
  return `
      <p style="margin:24px 0;">
        <a href="${url}" style="display:inline-block; background:#056BFE; color:#ffffff; text-decoration:none; font-weight:700; font-size:15px; padding:13px 26px; border-radius:999px;">${escapeHtml(label)}</a>
      </p>`;
}

// Inline link for a sentence, same null-safety as the button above.
function inlineLink(path, label) {
  const url = getAppUrl(path);
  if (!url) return escapeHtml(label);
  return `<a href="${url}" style="color:#056BFE;">${escapeHtml(label)}</a>`;
}

// The Resend SDK does NOT throw when the API rejects a send -- it resolves with
// { data: null, error: {...} }. Every sender here used to `await` that and move
// on, so a rejected email was indistinguishable from a delivered one: no throw,
// no log, nothing for a caller to react to. That is how a password reset that
// never sent looked exactly like one that did.
//
// This makes a failure a real error. Callers that must not fail because of
// email (notificationService) already catch; the ones that should tell the user
// something went wrong (password reset) now can.
async function send(payload) {
  const { data, error } = await resend.emails.send(payload);
  if (error) {
    const message = error.message || JSON.stringify(error);
    console.error(`[emailService] "${payload.subject}" to ${payload.to} REJECTED by Resend: ${message}`);
    throw new Error(message);
  }
  console.log(`[emailService] sent "${payload.subject}" to ${payload.to} (id ${data.id})`);
  return data;
}

// { email, name } works for either account type -- callers pass whichever
// display name they have (merchant owner/business name, or customer name).
// The bare URL is kept alongside the button on purpose: some mail clients
// strip styled anchors, and a visible link can always be copied by hand.
async function sendPasswordResetEmail({ email, name }, resetUrl) {
  if (!resend) {
    // Not configured yet (e.g. local dev without a real API key) -- log the
    // link instead of silently failing, so the flow is still testable.
    console.log(`[emailService] RESEND_API_KEY not set -- password reset link for ${email}:\n${resetUrl}`);
    return;
  }

  await send({
    from: FROM_ADDRESS,
    to: email,
    subject: 'Reset your ReceipTap password',
    html: `
      <p>Hi${name ? ' ' + name : ''},</p>
      <p>We got a request to reset your ReceipTap password. This link expires in 1 hour.</p>
      <p style="margin:24px 0;">
        <a href="${resetUrl}" style="display:inline-block; background:#056BFE; color:#ffffff; text-decoration:none; font-weight:700; font-size:15px; padding:13px 26px; border-radius:999px;">Reset your password</a>
      </p>
      <p style="color:#666; font-size:12px; word-break:break-all;">Or paste this into your browser:<br /><a href="${resetUrl}" style="color:#666;">${resetUrl}</a></p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `,
  });
}

// Demo-tier signup only (see routes/auth.js) -- gates the "Send test
// receipt" button on theme-settings until clicked.
async function sendVerificationEmail({ email, name }, verifyUrl) {
  if (!resend) {
    console.log(`[emailService] RESEND_API_KEY not set -- verification link for ${email}:\n${verifyUrl}`);
    return;
  }

  await send({
    from: FROM_ADDRESS,
    to: email,
    subject: 'Verify your email for ReceipTap',
    html: `
      <p>Hi${name ? ' ' + name : ''},</p>
      <p>Confirm this is your email to unlock test receipts on your free ReceipTap demo. This link expires in 24 hours.</p>
      <p style="margin:24px 0;">
        <a href="${verifyUrl}" style="display:inline-block; background:#056BFE; color:#ffffff; text-decoration:none; font-weight:700; font-size:15px; padding:13px 26px; border-radius:999px;">Verify my email</a>
      </p>
      <p style="color:#666; font-size:12px; word-break:break-all;">Or paste this into your browser:<br /><a href="${verifyUrl}" style="color:#666;">${verifyUrl}</a></p>
      <p>If you didn't sign up for ReceipTap, you can safely ignore this email.</p>
    `,
  });
}

// Sent the moment a customer's stamp card fills. Named reward, named shop --
// a "you have a reward" email that doesn't say what or where is worthless.
// Called only through notificationService, which handles the opt-out and
// suppression checks and swallows failures.
async function sendLoyaltyRewardReadyEmail({ email, name, merchantName, reward }) {
  const subject = `${reward} is waiting for you at ${merchantName}`;

  if (!resend) {
    console.log(`[emailService] RESEND_API_KEY not set -- loyalty reward email for ${email}: ${subject}`);
    return;
  }

  await send({
    from: FROM_ADDRESS,
    to: email,
    subject,
    html: `
      <p>Hi${name ? ' ' + name : ''},</p>
      <p>Your stamp card at <strong>${escapeHtml(merchantName)}</strong> is full.</p>
      <p style="font-size:18px; margin:18px 0;"><strong>${escapeHtml(reward)}</strong> is ready to claim on your next visit.</p>
      <p>Show it at the counter, or open it in your wallet.</p>
      ${actionButton('/account/loyalty', 'Open My Rewards')}
      <p style="color:#666; font-size:12px; margin-top:24px;">
        Don't want these? Turn off stamp card emails in your
        ${inlineLink('/account/settings', 'ReceipTap account settings')}.
      </p>
    `,
  });
}

// Sent twice per receipt at most -- 14 days out, then 3 days out (see
// services/warrantyReminderService.js, which dedupes each stage separately
// so this is never called twice for the same stage). Called only through
// notificationService.notifyWarrantyExpiring, same as the loyalty email
// above: opt-out/suppression checks and failure-swallowing live there, not
// here.
async function sendWarrantyExpiringEmail({ email, name, merchantName, totalLabel, expiresLabel, stage, linkUrl }) {
  const daysLabel = stage === '3d' ? '3 days' : 'about 2 weeks';
  const subject = `Your ${escapeHtml(merchantName)} warranty expires in ${daysLabel}`;

  if (!resend) {
    console.log(`[emailService] RESEND_API_KEY not set -- warranty reminder email for ${email}: ${subject}`);
    return;
  }

  await send({
    from: FROM_ADDRESS,
    to: email,
    subject,
    html: `
      <p>Hi${name ? ' ' + name : ''},</p>
      <p>The estimated warranty on your <strong>${escapeHtml(totalLabel)}</strong> purchase at
        <strong>${escapeHtml(merchantName)}</strong> ends <strong>${escapeHtml(expiresLabel)}</strong> --
        ${daysLabel} from now.</p>
      <p>If anything's wrong with it, now's the time to look into a repair or replacement while it's still covered.</p>
      ${actionButton(linkUrl, 'View receipt')}
      <p style="color:#666; font-size:12px; margin-top:24px;">
        This is an estimate based on what was purchased, not a copy of your actual warranty terms --
        check the receipt or manufacturer for the real coverage details.
      </p>
    `,
  });
}

// Sent when a merchant's subscription goes PAST_DUE or CANCELED (see
// services/stripeService.js's handleWebhookEvent). Deliberately email, not
// just the in-app bell: a payment problem can eventually restrict dashboard
// access, so relying on a notification that lives INSIDE the dashboard the
// merchant might be about to lose access to is exactly backwards. Called
// only through services/merchantNotificationService.js, which swallows
// failures the same way notificationService.js does for the customer side.
async function sendBillingProblemEmail({ email, name, businessName, status }) {
  const isCanceled = status === 'CANCELED';
  const subject = isCanceled
    ? 'Your ReceipTap subscription was canceled'
    : "There's a problem with your ReceipTap payment";

  if (!resend) {
    console.log(`[emailService] RESEND_API_KEY not set -- billing problem email for ${email}: ${subject}`);
    return;
  }

  await send({
    from: FROM_ADDRESS,
    to: email,
    subject,
    html: `
      <p>Hi${name ? ' ' + name : ''},</p>
      ${isCanceled
        ? `<p>The ReceipTap subscription for <strong>${escapeHtml(businessName)}</strong> has been canceled.</p>`
        : `<p>We couldn't process the latest payment for <strong>${escapeHtml(businessName)}</strong>'s ReceipTap subscription.</p>`}
      <p>${isCanceled ? 'Resubscribe' : 'Update your payment method'} to keep receipts, loyalty cards, and your dashboard working without interruption.</p>
      ${actionButton('/account/business/billing', isCanceled ? 'Resubscribe' : 'Update payment method')}
    `,
  });
}

// Merchant-controlled text (business name, reward label) goes into an HTML
// email -- escape it rather than trusting it, the same way every other
// merchant-supplied string is escaped before it reaches a page.
function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  sendPasswordResetEmail,
  sendVerificationEmail,
  sendLoyaltyRewardReadyEmail,
  sendWarrantyExpiringEmail,
  sendBillingProblemEmail,
};
