// routes/auth.js
// Merchant account creation and session login — the missing piece every
// other route (requireAuth checking req.session.merchantId) depends on.

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { sendPasswordResetEmail } = require('../services/emailService');

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

router.get('/signup', (req, res) => res.render('signup', { error: null, refCode: req.query.ref || '' }));
router.get('/login', (req, res) => res.render('login', {
  error: null,
  deactivated: req.query.deactivated === '1',
  redirect: req.query.redirect || '/dashboard/receipts-hub',
}));

router.post('/signup', async (req, res) => {
  const { ownerName, businessName, email, password, refCode } = req.body;

  if (!ownerName || !businessName || !email || !password) {
    return res.render('signup', { error: 'All fields are required', refCode: refCode || '' });
  }

  try {
    const existing = await prisma.merchant.findUnique({ where: { email } });
    if (existing) {
      return res.render('signup', { error: 'An account with this email already exists', refCode: refCode || '' });
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

    req.session.merchantId = merchant.id;
    res.redirect('/dashboard/receipts-hub');
  } catch (err) {
    console.error('Signup failed:', err);
    res.render('signup', { error: 'Something went wrong on our end — please try again in a moment.', refCode: refCode || '' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const redirect = req.body.redirect || '/dashboard/receipts-hub';

  try {
    const merchant = await prisma.merchant.findUnique({ where: { email } });
    if (!merchant || !(await bcrypt.compare(password, merchant.passwordHash))) {
      return res.render('login', { error: 'Invalid email or password', redirect });
    }
    if (!merchant.isActive) {
      return res.render('login', { error: 'This account has been deactivated.', redirect });
    }

    req.session.merchantId = merchant.id;
    res.redirect(redirect);
  } catch (err) {
    console.error('Login failed:', err);
    res.render('login', { error: 'Something went wrong on our end — please try again in a moment.', redirect });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
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
      await sendPasswordResetEmail(merchant, resetUrl);
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
