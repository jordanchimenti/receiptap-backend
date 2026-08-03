// services/emailService.js
// Transactional email, currently just the "forgot password" reset link.
// Guarded the same way Stripe is (see services/stripeService.js) -- an empty
// API key must never throw at startup and take the whole server down.

const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// resend.dev's shared sandbox sender works with zero setup (no domain
// verification needed) -- fine for now, swap in a verified "from" address
// on your own domain once RESEND_FROM_EMAIL is set for that.
const FROM_ADDRESS = process.env.RESEND_FROM_EMAIL || 'ReceipTap <onboarding@resend.dev>';

async function sendPasswordResetEmail(merchant, resetUrl) {
  if (!resend) {
    // Not configured yet (e.g. local dev without a real API key) -- log the
    // link instead of silently failing, so the flow is still testable.
    console.log(`[emailService] RESEND_API_KEY not set -- password reset link for ${merchant.email}:\n${resetUrl}`);
    return;
  }

  await resend.emails.send({
    from: FROM_ADDRESS,
    to: merchant.email,
    subject: 'Reset your ReceipTap password',
    html: `
      <p>Hi ${merchant.ownerName || merchant.businessName},</p>
      <p>We got a request to reset your ReceipTap password. This link expires in 1 hour:</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `,
  });
}

module.exports = { sendPasswordResetEmail };
