// services/emailService.js
// Transactional email: password resets, address verification, and the
// "your stamp card is full" note (see services/notificationService.js).
// Guarded the same way Stripe is (see services/stripeService.js) -- an empty
// API key must never throw at startup and take the whole server down.

const { Resend } = require('resend');
const { getAppUrl } = require('../lib/baseUrl');
const { RETURN_ADDRESS } = require('../config/entity');

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

// Sent when a merchant's monthly subscription charge actually plants a real
// tree (see services/goodApiService.js's plantTreeForSubscriptionMonth).
// Called only through merchantNotificationService.js's notifyTreePlanted,
// which already only fires on a CONFIRMED plant -- never on a missing key or
// a GoodAPI outage -- and swallows failures the same way
// sendBillingProblemEmail's caller does, so an email hiccup here can never
// break the webhook that triggered it.
async function sendTreePlantedEmail({ email, name, businessName, treesPlanted, impactUrl }) {
  const subject = 'Thank you — your subscription just planted a real tree';

  if (!resend) {
    console.log(`[emailService] RESEND_API_KEY not set -- tree-planted email for ${email}: ${subject}`);
    return;
  }

  const treesLabel = `${treesPlanted} tree${treesPlanted === 1 ? '' : 's'}`;

  await send({
    from: FROM_ADDRESS,
    to: email,
    subject,
    html: `
      <p>Hi${name ? ' ' + name : ''},</p>
      <p>Thank you for staying subscribed to ReceipTap. This month's payment for
        <strong>${escapeHtml(businessName)}</strong> planted one real, GPS-tracked tree through our
        partner GoodAPI.</p>
      <p style="font-size:18px; margin:18px 0;"><strong>${treesLabel}</strong> planted so far, just from ${escapeHtml(businessName)} staying subscribed.</p>
      <p>You can see exactly where it was planted on our live impact map.</p>
      <p style="margin:24px 0;">
        <a href="${impactUrl}" style="display:inline-block; background:#056BFE; color:#ffffff; text-decoration:none; font-weight:700; font-size:15px; padding:13px 26px; border-radius:999px;">See the live impact map</a>
      </p>
      <p>Thank you for making this possible.</p>
    `,
  });
}

// The actual mechanism behind the Terms' "we'll email a prepaid return
// label to the address on file" promise (Hardware section) -- called from
// services/stripeService.js's syncPuckReturnWindows the moment a return
// window starts, whether or not a real label ended up getting bought
// (labelUrl/trackingUrl are null when it didn't -- see
// services/easypostService.js's createReturnLabel for every reason that
// can happen). This is the one channel that reaches a merchant who used
// "Deactivate account": that flow destroys their session immediately and
// they can never log back in, so an in-app notification alone could never
// reach them -- email is the only thing that can.
async function sendReturnPucksEmail({ email, name, businessName, puckCount, deadline, labelUrl, trackingUrl }) {
  const subject = puckCount === 1 ? 'Return your ReceipTap puck' : `Return your ${puckCount} ReceipTap pucks`;

  if (!resend) {
    console.log(`[emailService] RESEND_API_KEY not set -- return-pucks email for ${email}: ${subject}`);
    return;
  }

  const deadlineLabel = deadline.toLocaleDateString('en-US', { dateStyle: 'long' });
  const puckLabel = puckCount === 1 ? '1 puck' : `${puckCount} pucks`;
  const addressLines = [
    RETURN_ADDRESS.name,
    RETURN_ADDRESS.street1,
    RETURN_ADDRESS.street2,
    `${RETURN_ADDRESS.city}, ${RETURN_ADDRESS.state} ${RETURN_ADDRESS.zip}`,
    'Canada',
  ].filter(Boolean);

  await send({
    from: FROM_ADDRESS,
    to: email,
    subject,
    html: `
      <p>Hi${name ? ' ' + name : ''},</p>
      <p><strong>${escapeHtml(businessName)}</strong> has ${puckLabel} to return to ReceipTap by
        <strong>${deadlineLabel}</strong>. A puck not returned by then is billed as a $60 USD
        replacement, per the Hardware section of our Terms.</p>
      ${labelUrl
        ? `<p>We've prepaid the postage — print the label below, box up the puck(s), and drop the package off.</p>
           <p style="margin:24px 0;">
             <a href="${labelUrl}" style="display:inline-block; background:#056BFE; color:#ffffff; text-decoration:none; font-weight:700; font-size:15px; padding:13px 26px; border-radius:999px;">Download prepaid shipping label</a>
           </p>
           ${trackingUrl ? `<p style="font-size:13px;">Track the return: <a href="${trackingUrl}" style="color:#056BFE;">${trackingUrl}</a></p>` : ''}`
        : `<p>Pack up the puck(s) and ship them, at your own cost, to:</p>
           <p style="margin:16px 0; padding:14px 16px; background:#f4f2ec; border-radius:10px; font-size:14px; line-height:1.6;">
             ${addressLines.map(escapeHtml).join('<br>')}
           </p>`}
      <p style="font-size:13px; color:#666;">Already sent it back? No action needed — we'll mark it received once it arrives.</p>
    `,
  });
}

// Fired the moment services/hardwareOrderService.js confirms payment for a
// HardwareOrder (mirrors sendReturnPucksEmail's shape, opposite direction:
// this is a puck shipping TO the merchant, not back from them). labelUrl is
// often already known by the time this sends, since the outbound label is
// bought synchronously right after payment -- but not always (EasyPost down,
// not configured yet), so this reads the same either way as
// sendReturnPucksEmail's own null-labelUrl branch.
async function sendHardwareOrderConfirmationEmail({ email, name, businessName, orderNumber, quantity, feeLabel, labelUrl, trackingUrl }) {
  const subject = `Order confirmed — ${orderNumber}`;

  if (!resend) {
    console.log(`[emailService] RESEND_API_KEY not set -- order confirmation email for ${email}: ${subject}`);
    return;
  }

  const puckLabel = quantity === 1 ? '1 ReceipTap' : `${quantity} ReceipTaps`;

  await send({
    from: FROM_ADDRESS,
    to: email,
    subject,
    html: `
      <p>Hi${name ? ' ' + name : ''},</p>
      <p>Order <strong>${escapeHtml(orderNumber)}</strong> for <strong>${escapeHtml(businessName)}</strong> is
        confirmed — ${puckLabel}, ${feeLabel} shipping paid.</p>
      ${labelUrl
        ? `<p>Your prepaid shipping label is ready — we'll drop it in the mail shortly.</p>
           ${trackingUrl ? `<p style="font-size:13px;">Track it: <a href="${trackingUrl}" style="color:#056BFE;">${trackingUrl}</a></p>` : ''}`
        : `<p>We'll email you again the moment it ships.</p>`}
      ${actionButton('/account/business/orders', 'View order status')}
    `,
  });
}

// Fired by services/hardwareOrderService.js's periodic tracking refresh the
// moment a HardwareOrder's carrier status genuinely changes (shipped or
// delivered) -- not on every poll, only on a real transition. In-app
// notification is the record of record (services/merchantNotificationService.js);
// this is the best-effort email copy of it, same pattern as everywhere else
// in this file.
async function sendHardwareOrderStatusEmail({ email, name, businessName, orderNumber, status, trackingUrl }) {
  const isDelivered = status === 'delivered';
  const subject = isDelivered ? `Delivered — ${orderNumber}` : `On its way — ${orderNumber}`;

  if (!resend) {
    console.log(`[emailService] RESEND_API_KEY not set -- order status email for ${email}: ${subject}`);
    return;
  }

  await send({
    from: FROM_ADDRESS,
    to: email,
    subject,
    html: `
      <p>Hi${name ? ' ' + name : ''},</p>
      <p>Order <strong>${escapeHtml(orderNumber)}</strong> for <strong>${escapeHtml(businessName)}</strong>
        ${isDelivered ? 'has been delivered.' : 'is on its way.'}</p>
      ${trackingUrl && !isDelivered ? `<p style="font-size:13px;">Track it: <a href="${trackingUrl}" style="color:#056BFE;">${trackingUrl}</a></p>` : ''}
      ${isDelivered ? `<p>Once you've unboxed it, tap it and enter the claim code printed on the insert card to link it to your account.</p>` : ''}
      ${actionButton('/account/business/orders', 'View order status')}
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
  sendTreePlantedEmail,
  sendReturnPucksEmail,
  sendHardwareOrderConfirmationEmail,
  sendHardwareOrderStatusEmail,
};
