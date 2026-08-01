// routes/auth.js
// Merchant account creation and session login — the missing piece every
// other route (requireAuth checking req.session.merchantId) depends on.

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const prisma = require('../lib/prisma');

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

module.exports = router;
