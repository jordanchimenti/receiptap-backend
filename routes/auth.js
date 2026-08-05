// routes/auth.js
// Merchant account creation and session login — the missing piece every
// other route (requireAuth checking req.session.merchantId) depends on.

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const prisma = require('../lib/prisma');
const { sendPasswordResetEmail } = require('../services/emailService');
const { recordLegalAcceptances } = require('../services/legalAcceptanceService');
const { safeNextPath } = require('../lib/safeRedirect');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

router.get('/signup', (req, res) => res.render('signup', {
  error: null,
  refCode: req.query.ref || '',
  next: req.query.next || '',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
}));
router.get('/login', (req, res) => res.render('login', {
  error: null,
  deactivated: req.query.deactivated === '1',
  redirect: req.query.redirect || '/dashboard/receipts-hub',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
}));

router.post('/signup', async (req, res) => {
  const { ownerName, businessName, email, password, refCode, next, acceptTerms, acceptPrivacy, acceptDpa } = req.body;

  if (!ownerName || !businessName || !email || !password) {
    return res.render('signup', { error: 'All fields are required', refCode: refCode || '', next: next || '', googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
  }
  // Client-side "required" on the checkboxes is UX only -- this is the real
  // gate. A request with any of the three missing never creates an account.
  if (!acceptTerms || !acceptPrivacy || !acceptDpa) {
    return res.render('signup', { error: 'You must accept the Terms of Service, Privacy Policy, and Data Processing Agreement to create an account.', refCode: refCode || '', next: next || '', googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
  }

  try {
    const existing = await prisma.merchant.findUnique({ where: { email } });
    if (existing) {
      return res.render('signup', { error: 'An account with this email already exists', refCode: refCode || '', next: next || '', googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
    }

    // Referral is best-effort -- an invalid/expired code shouldn't block signup,
    // it just means this merchant signs up without an attributed affiliate.
    const referrer = refCode
      ? await prisma.affiliate.findUnique({ where: { referralCode: refCode.trim().toUpperCase() } })
      : null;

    const passwordHash = await bcrypt.hash(password, 10);
    const merchant = await prisma.merchant.create({
      data: { ownerName, businessName, email, passwordHash, referredByAffiliateId: referrer?.id || null },
    });
    await recordLegalAcceptances(merchant.id, req);

    req.session.merchantId = merchant.id;
    res.redirect(safeNextPath(next));
  } catch (err) {
    console.error('Signup failed:', err);
    res.render('signup', { error: 'Something went wrong on our end — please try again in a moment.', refCode: refCode || '', next: next || '', googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const redirect = req.body.redirect || '/dashboard/receipts-hub';
  const googleClientId = process.env.GOOGLE_CLIENT_ID || '';

  try {
    const merchant = await prisma.merchant.findUnique({ where: { email } });
    if (!merchant || !merchant.passwordHash || !(await bcrypt.compare(password, merchant.passwordHash))) {
      return res.render('login', { error: 'Invalid email or password', redirect, googleClientId });
    }
    if (!merchant.isActive) {
      return res.render('login', { error: 'This account has been deactivated.', redirect, googleClientId });
    }

    req.session.merchantId = merchant.id;
    res.redirect(redirect);
  } catch (err) {
    console.error('Login failed:', err);
    res.render('login', { error: 'Something went wrong on our end — please try again in a moment.', redirect, googleClientId });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// --- Sign in with Google (doubles as signup — one step for both) ------------
// Used by both the login page and the signup page: if the Google account's
// email doesn't have a Merchant record yet, one is created automatically.
// Business/owner name aren't knowable from Google alone, so a new account
// gets an editable placeholder business name -- same tradeoff already made
// for the equivalent customer-facing flow in routes/customer-account.js.
router.post('/merchant/google', async (req, res) => {
  const { credential, refCode, next, acceptTerms, acceptPrivacy, acceptDpa } = req.body;
  if (!credential) return res.status(400).json({ error: 'Missing Google credential' });

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    return res.status(401).json({ error: 'Could not verify Google sign-in' });
  }

  if (!payload.email) return res.status(400).json({ error: 'Google account has no email' });
  const email = payload.email.toLowerCase();

  try {
    let merchant = await prisma.merchant.findUnique({ where: { email } });

    if (merchant) {
      if (!merchant.isActive) return res.status(403).json({ error: 'This account has been deactivated.' });
      if (!merchant.googleId) {
        merchant = await prisma.merchant.update({ where: { id: merchant.id }, data: { googleId: payload.sub } });
      }
    } else {
      // New account -- same consent requirement as the plain signup form
      // (views/signup.ejs checks this client-side too, but that can always
      // be bypassed, so it's enforced here independently).
      if (!acceptTerms || !acceptPrivacy || !acceptDpa) {
        return res.status(400).json({ error: 'Please accept the Terms of Service, Privacy Policy, and Data Processing Agreement first.' });
      }

      const referrer = refCode
        ? await prisma.affiliate.findUnique({ where: { referralCode: refCode.trim().toUpperCase() } })
        : null;

      merchant = await prisma.merchant.create({
        data: {
          email,
          googleId: payload.sub,
          ownerName: payload.name || null,
          businessName: payload.given_name ? `${payload.given_name}'s Business` : 'My Business',
          referredByAffiliateId: referrer?.id || null,
        },
      });
      await recordLegalAcceptances(merchant.id, req);
    }

    req.session.merchantId = merchant.id;
    res.json({ success: true, redirect: safeNextPath(next) });
  } catch (err) {
    console.error('Google sign-in failed:', err);
    res.status(500).json({ error: 'Something went wrong on our end — please try again in a moment.' });
  }
});

router.get('/forgot-password', (req, res) => res.render('forgot-password', { error: null, sent: false }));

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  try {
    const merchant = email ? await prisma.merchant.findUnique({ where: { email } }) : null;

    // Always render the same success state whether or not the email has an
    // account -- otherwise this becomes a way to check who's a merchant.
    if (merchant) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      await prisma.merchant.update({
        where: { id: merchant.id },
        data: { resetToken, resetTokenExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
      });

      const resetUrl = `${req.protocol}://${req.get('host')}/reset-password/${resetToken}`;
      await sendPasswordResetEmail({ email: merchant.email, name: merchant.ownerName || merchant.businessName }, resetUrl);
    }

    res.render('forgot-password', { error: null, sent: true });
  } catch (err) {
    console.error('Forgot-password request failed:', err);
    res.render('forgot-password', { error: 'Something went wrong on our end — please try again in a moment.', sent: false });
  }
});

router.get('/reset-password/:token', async (req, res) => {
  const merchant = await prisma.merchant.findUnique({ where: { resetToken: req.params.token } });
  const valid = Boolean(merchant && merchant.resetTokenExpiresAt > new Date());
  res.render('reset-password', { token: req.params.token, valid, error: null });
});

router.post('/reset-password/:token', async (req, res) => {
  const { password, confirmPassword } = req.body;
  const merchant = await prisma.merchant.findUnique({ where: { resetToken: req.params.token } });
  const valid = Boolean(merchant && merchant.resetTokenExpiresAt > new Date());

  if (!valid) {
    return res.render('reset-password', { token: req.params.token, valid: false, error: null });
  }
  if (!password || password.length < 8) {
    return res.render('reset-password', { token: req.params.token, valid: true, error: 'Password must be at least 8 characters.' });
  }
  if (password !== confirmPassword) {
    return res.render('reset-password', { token: req.params.token, valid: true, error: 'Passwords do not match.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.merchant.update({
    where: { id: merchant.id },
    data: { passwordHash, resetToken: null, resetTokenExpiresAt: null },
  });

  req.session.merchantId = merchant.id;
  res.redirect('/dashboard/receipts-hub');
});

module.exports = router;
