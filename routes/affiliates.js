// routes/affiliates.js
// The referral/commission program. Two kinds of affiliate share one table:
//   MERCHANT — an existing merchant referring others, 20% while their own
//     subscription is ACTIVE. No separate login -- reuses their merchant
//     session via Merchant.ownAffiliateAccount.
//   REGULAR  — a standalone affiliate (e.g. future sales team) with their
//     own signup/login, flat 15%, not tied to a Merchant account.
//
// Phase 1 (this file): accounts, referral codes/links, and referred-merchant
// tracking. Commission calculation and Stripe Connect payouts come later --
// this only creates the Affiliate/Commission rows and relationships so
// referrals are tracked correctly from day one.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const prisma = require('../lib/prisma');

const MERCHANT_AFFILIATE_RATE = 20;
const REGULAR_AFFILIATE_RATE = 15;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I -- easy to read off/type
function generateReferralCode() {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

async function uniqueReferralCode() {
  for (let i = 0; i < 5; i++) {
    const code = generateReferralCode();
    const existing = await prisma.affiliate.findUnique({ where: { referralCode: code } });
    if (!existing) return code;
  }
  throw new Error('Could not generate a unique referral code');
}

function requireMerchantAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

function requireAffiliateAuth(req, res, next) {
  if (!req.session?.affiliateId) {
    return res.redirect(`/affiliate/login?redirect=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

// Shared shape for both dashboards -- fetches referred merchants + commissions,
// and computes whether commissions are currently eligible to accrue.
async function buildAffiliateView(affiliate) {
  const [referredMerchants, commissions] = await Promise.all([
    prisma.merchant.findMany({
      where: { referredByAffiliateId: affiliate.id },
      select: { id: true, businessName: true, subscriptionStatus: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.commission.findMany({
      where: { affiliateId: affiliate.id },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const rate = affiliate.type === 'MERCHANT' ? MERCHANT_AFFILIATE_RATE : REGULAR_AFFILIATE_RATE;

  // Merchant-affiliates only earn while their OWN subscription is active --
  // regular affiliates have no such condition.
  let isEligible = true;
  let ownMerchant = null;
  if (affiliate.type === 'MERCHANT') {
    ownMerchant = await prisma.merchant.findUnique({ where: { id: affiliate.merchantId } });
    isEligible = ownMerchant?.subscriptionStatus === 'ACTIVE';
  }

  const pendingCents = commissions.filter((c) => c.status === 'PENDING').reduce((sum, c) => sum + c.amountCents, 0);
  const paidCents = commissions.filter((c) => c.status === 'PAID').reduce((sum, c) => sum + c.amountCents, 0);

  return {
    referralCode: affiliate.referralCode,
    rate,
    isEligible,
    ownSubscriptionStatus: ownMerchant?.subscriptionStatus || null,
    stripeConnectOnboarded: affiliate.stripeConnectOnboarded,
    referredMerchants: referredMerchants.map((m) => ({
      businessName: m.businessName,
      subscriptionStatus: m.subscriptionStatus,
      joinedAt: m.createdAt.toLocaleDateString('en-US', { dateStyle: 'medium' }),
    })),
    commissions: commissions.map((c) => ({
      amount: (c.amountCents / 100).toFixed(2),
      rate: c.rate,
      status: c.status,
      date: c.createdAt.toLocaleDateString('en-US', { dateStyle: 'medium' }),
    })),
    pendingTotal: (pendingCents / 100).toFixed(2),
    paidTotal: (paidCents / 100).toFixed(2),
  };
}

// --- Merchant-affiliate: reuses the existing merchant session ---------------
router.get('/dashboard/referrals', requireMerchantAuth, async (req, res) => {
  let affiliate = await prisma.affiliate.findUnique({ where: { merchantId: req.session.merchantId } });

  if (!affiliate) {
    const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
    affiliate = await prisma.affiliate.create({
      data: {
        name: merchant.ownerName || merchant.businessName,
        email: merchant.email,
        type: 'MERCHANT',
        merchantId: merchant.id,
        referralCode: await uniqueReferralCode(),
      },
    });
  }

  const view = await buildAffiliateView(affiliate);
  res.render('affiliate-dashboard', {
    ...view,
    portalType: 'merchant',
    referralUrl: `${req.protocol}://${req.get('host')}/signup?ref=${view.referralCode}`,
  });
});

// --- Regular affiliate: standalone signup/login --------------------------

router.get('/affiliate/signup', (req, res) => res.render('affiliate-signup', { error: null }));
router.get('/affiliate/login', (req, res) => res.render('affiliate-login', {
  error: null,
  redirect: req.query.redirect || '/affiliate/dashboard',
}));

router.post('/affiliate/signup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.render('affiliate-signup', { error: 'All fields are required' });
  }

  try {
    const existing = await prisma.affiliate.findUnique({ where: { email } });
    if (existing) {
      return res.render('affiliate-signup', { error: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const affiliate = await prisma.affiliate.create({
      data: { name, email, passwordHash, type: 'REGULAR', referralCode: await uniqueReferralCode() },
    });

    req.session.affiliateId = affiliate.id;
    res.redirect('/affiliate/dashboard');
  } catch (err) {
    console.error('Affiliate signup failed:', err);
    res.render('affiliate-signup', { error: 'Something went wrong on our end — please try again in a moment.' });
  }
});

router.post('/affiliate/login', async (req, res) => {
  const { email, password } = req.body;
  const redirect = req.body.redirect || '/affiliate/dashboard';

  try {
    const affiliate = await prisma.affiliate.findUnique({ where: { email } });
    if (!affiliate || !affiliate.passwordHash || !(await bcrypt.compare(password, affiliate.passwordHash))) {
      return res.render('affiliate-login', { error: 'Invalid email or password', redirect });
    }

    req.session.affiliateId = affiliate.id;
    res.redirect(redirect);
  } catch (err) {
    console.error('Affiliate login failed:', err);
    res.render('affiliate-login', { error: 'Something went wrong on our end — please try again in a moment.', redirect });
  }
});

router.post('/affiliate/logout', (req, res) => {
  delete req.session.affiliateId;
  res.redirect('/affiliate/login');
});

router.get('/affiliate/dashboard', requireAffiliateAuth, async (req, res) => {
  const affiliate = await prisma.affiliate.findUnique({ where: { id: req.session.affiliateId } });
  const view = await buildAffiliateView(affiliate);
  res.render('affiliate-dashboard', {
    ...view,
    portalType: 'regular',
    affiliateName: affiliate.name,
    referralUrl: `${req.protocol}://${req.get('host')}/signup?ref=${view.referralCode}`,
  });
});

module.exports = router;
