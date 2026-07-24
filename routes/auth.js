// routes/auth.js
// Merchant account creation and session login — the missing piece every
// other route (requireAuth checking req.session.merchantId) depends on.

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.get('/signup', (req, res) => res.render('signup', { error: null }));
router.get('/login', (req, res) => res.render('login', { error: null, redirect: req.query.redirect || '/dashboard/receipts-hub' }));

router.post('/signup', async (req, res) => {
  const { businessName, email, password } = req.body;

  if (!businessName || !email || !password) {
    return res.render('signup', { error: 'All fields are required' });
  }

  const existing = await prisma.merchant.findUnique({ where: { email } });
  if (existing) {
    return res.render('signup', { error: 'An account with this email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const merchant = await prisma.merchant.create({
    data: { businessName, email, passwordHash },
  });

  req.session.merchantId = merchant.id;
  res.redirect('/dashboard/receipts-hub');
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  const merchant = await prisma.merchant.findUnique({ where: { email } });
  if (!merchant || !(await bcrypt.compare(password, merchant.passwordHash))) {
    return res.render('login', { error: 'Invalid email or password', redirect: req.body.redirect || '/dashboard/receipts-hub' });
  }

  req.session.merchantId = merchant.id;
  res.redirect(req.body.redirect || '/dashboard/receipts-hub');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
