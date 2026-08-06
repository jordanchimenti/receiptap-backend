// routes/affiliates.js
// The referral/commission program. Two kinds of affiliate share one table:
//   MERCHANT — an existing merchant referring others, 10% while their own
//     subscription is ACTIVE. No separate login -- reuses their merchant
//     session via Merchant.ownAffiliateAccount.
//   REGULAR  — a standalone affiliate (e.g. future sales team) with their
//     own signup/login, flat 20%, not tied to a Merchant account.
//
// Phase 1: accounts, referral codes/links, and referred-merchant tracking.
// Phase 2: Stripe Connect onboarding, so an affiliate can actually receive
// a payout once one exists.
// Phase 3 (this file now includes it): commission calculation lives in
// services/stripeService.js, triggered by the real invoice.payment_succeeded
// webhook event (routes/billing.js). This file's role is just paying out
// any commissions that piled up PENDING before the affiliate finished
// connecting Stripe -- see /affiliate/connect-stripe/return below.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const prisma = require('../lib/prisma');
const {
  createAffiliateConnectAccount,
  createAffiliateOnboardingLink,
  getAffiliateConnectStatus,
  payPendingCommissionsForAffiliate,
} = require('../services/stripeService');
const { MERCHANT_AFFILIATE_RATE, REGULAR_AFFILIATE_RATE } = require('../services/affiliateRates');
const { getBaseUrl } = require('../lib/baseUrl');

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

// Every merchant is eligible for the Merchant Partner Program without a
// separate signup step -- this lazily creates their MERCHANT-type affiliate
// row (and referral code) the first time it's needed, whether that's them
// visiting their own dashboard or turning on the receipt banner in Settings.
// Exported so other routes (theme-settings.js) can reuse it.
async function ensureMerchantAffiliate(merchantId) {
  let affiliate = await prisma.affiliate.findUnique({ where: { merchantId } });
  if (!affiliate) {
    const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
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
  return affiliate;
}

// Resolves the current affiliate regardless of which session type is
// present -- a merchant browsing their own "Partner Program" page, or a
// regular affiliate logged into their own portal.
async function getCurrentAffiliate(req) {
  if (req.session?.affiliateId) {
    return prisma.affiliate.findUnique({ where: { id: req.session.affiliateId } });
  }
  if (req.session?.merchantId) {
    return ensureMerchantAffiliate(req.session.merchantId);
  }
  return null;
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

  // Of the merchants this affiliate referred who ever actually started using
  // ReceipTap (i.e. excluding INCOMPLETE -- someone who signed up via the
  // link but never started a trial was never a customer to begin with, so
  // they were never a "churn" candidate), what fraction have since canceled.
  // null (not 0%) when there's no engaged referral yet -- 0/0 isn't a real rate.
  const engagedMerchants = referredMerchants.filter((m) => m.subscriptionStatus !== 'INCOMPLETE');
  const churnedCount = referredMerchants.filter((m) => m.subscriptionStatus === 'CANCELED').length;
  const churnRate = engagedMerchants.length > 0 ? Math.round((churnedCount / engagedMerchants.length) * 100) : null;

  return {
    referralCode: affiliate.referralCode,
    rate,
    isEligible,
    ownSubscriptionStatus: ownMerchant?.subscriptionStatus || null,
    isDemoAccount: ownMerchant?.isDemoAccount || false,
    stripeConnectOnboarded: affiliate.stripeConnectOnboarded,
    payoutFrequency: affiliate.payoutFrequency,
    churnRate,
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
  const affiliate = await getCurrentAffiliate(req);
  const view = await buildAffiliateView(affiliate);
  res.render('affiliate-dashboard', {
    ...view,
    portalType: 'merchant',
    referralUrl: `${getBaseUrl(req)}/signup?ref=${view.referralCode}`,
    connectError: req.query.connect_error === '1',
    codeError: req.query.code_error || null,
    codeSuccess: req.query.code_success === '1',
  });
});

// --- Public landing pages -- one per program, fully separate, no login required ---

router.get('/partner-program/merchant', (req, res) => {
  res.render('partner-program-merchant', { rate: MERCHANT_AFFILIATE_RATE });
});

router.get('/partner-program/affiliate', (req, res) => {
  res.render('partner-program-affiliate', { rate: REGULAR_AFFILIATE_RATE });
});

// --- Regular affiliate: standalone signup/login --------------------------

router.get('/affiliate/signup', (req, res) => res.render('affiliate-signup', { error: null, rate: REGULAR_AFFILIATE_RATE }));
router.get('/affiliate/login', (req, res) => res.render('affiliate-login', {
  error: null,
  redirect: req.query.redirect || '/affiliate/dashboard',
}));

router.post('/affiliate/signup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.render('affiliate-signup', { error: 'All fields are required', rate: REGULAR_AFFILIATE_RATE });
  }

  try {
    const existing = await prisma.affiliate.findUnique({ where: { email } });
    if (existing) {
      // Don't dead-end on a duplicate email -- log them into the existing
      // account instead. Still verify the password rather than trusting
      // whatever was typed, so this can't be used to take over someone
      // else's account just by knowing their email.
      if (existing.passwordHash) {
        const matches = await bcrypt.compare(password, existing.passwordHash);
        if (!matches) {
          return res.render('affiliate-signup', {
            error: 'An account with this email already exists. Enter its password to continue, or log in instead.',
            rate: REGULAR_AFFILIATE_RATE,
          });
        }
      } else {
        // No password set yet -- e.g. a merchant's affiliate account, which
        // is auto-created without one. This attempt sets it now.
        const passwordHash = await bcrypt.hash(password, 10);
        await prisma.affiliate.update({ where: { id: existing.id }, data: { passwordHash } });
      }

      req.session.affiliateId = existing.id;
      return res.redirect('/affiliate/dashboard');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const affiliate = await prisma.affiliate.create({
      data: { name, email, passwordHash, type: 'REGULAR', referralCode: await uniqueReferralCode() },
    });

    req.session.affiliateId = affiliate.id;
    res.redirect('/affiliate/dashboard');
  } catch (err) {
    console.error('Affiliate signup failed:', err);
    res.render('affiliate-signup', { error: 'Something went wrong on our end — please try again in a moment.', rate: REGULAR_AFFILIATE_RATE });
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
    // The account itself can be either type (e.g. a merchant who signed up
    // here with their merchant email lands on their existing MERCHANT-type
    // account) -- label the page after the real program, not just the route.
    programName: affiliate.type === 'MERCHANT' ? 'Merchant Partner Program' : 'Affiliate Partner Program',
    affiliateName: affiliate.name,
    referralUrl: `${getBaseUrl(req)}/signup?ref=${view.referralCode}`,
    connectError: req.query.connect_error === '1',
    codeError: req.query.code_error || null,
    codeSuccess: req.query.code_success === '1',
  });
});

function dashboardPathFor(affiliate) {
  return affiliate.type === 'MERCHANT' ? '/dashboard/referrals' : '/affiliate/dashboard';
}

// How often accumulated commissions get paid out -- doesn't trigger anything
// itself, just changes what runScheduledPayouts (services/stripeService.js)
// picks up on its next check.
router.post('/affiliate/payout-frequency', async (req, res) => {
  const affiliate = await getCurrentAffiliate(req);
  if (!affiliate) return res.redirect('/login');

  const safeFrequency = req.body.payoutFrequency === 'MONTHLY' ? 'MONTHLY' : 'WEEKLY';
  await prisma.affiliate.update({ where: { id: affiliate.id }, data: { payoutFrequency: safeFrequency } });

  res.redirect(dashboardPathFor(affiliate));
});

// Lets an affiliate replace their system-generated referralCode with a
// custom one (e.g. "JORDAN20" instead of "2CM9GU6F") -- same field, same
// uniqueness constraint, just affiliate-chosen instead of random. Normalized
// to uppercase because routes/auth.js's signup lookup does
// `refCode.trim().toUpperCase()` -- codes are case-insensitive everywhere
// they're actually looked up, so storing anything but the uppercased form
// would make two different-looking codes silently collide.
const CUSTOM_CODE_PATTERN = /^[A-Za-z0-9]{3,20}$/;
const RESERVED_REFERRAL_CODES = new Set(['PREVIEW']); // theme-settings.js's placeholder for an unclaimed preview link

router.post('/affiliate/referral-code', async (req, res) => {
  const affiliate = await getCurrentAffiliate(req);
  if (!affiliate) return res.redirect('/login');

  const requested = (req.body.referralCode || '').trim().toUpperCase();

  if (!CUSTOM_CODE_PATTERN.test(requested)) {
    return res.redirect(
      `${dashboardPathFor(affiliate)}?code_error=${encodeURIComponent('Your link can only use letters and numbers, 3-20 characters.')}`
    );
  }
  if (RESERVED_REFERRAL_CODES.has(requested)) {
    return res.redirect(
      `${dashboardPathFor(affiliate)}?code_error=${encodeURIComponent('That code is reserved -- please choose another.')}`
    );
  }
  if (requested === affiliate.referralCode) {
    return res.redirect(dashboardPathFor(affiliate)); // unchanged, nothing to do
  }

  const existing = await prisma.affiliate.findUnique({ where: { referralCode: requested } });
  if (existing) {
    return res.redirect(
      `${dashboardPathFor(affiliate)}?code_error=${encodeURIComponent('That link is already taken -- please choose another.')}`
    );
  }

  await prisma.affiliate.update({ where: { id: affiliate.id }, data: { referralCode: requested } });
  res.redirect(`${dashboardPathFor(affiliate)}?code_success=1`);
});

// --- Stripe Connect onboarding (shared by both affiliate types) -----------
// The affiliate never enters bank/ID details into this app -- they're sent
// to a Stripe-hosted page that collects that directly, and Stripe redirects
// back here afterward. Works for whichever session type is present.

router.get('/affiliate/connect-stripe/start', async (req, res) => {
  const affiliate = await getCurrentAffiliate(req);
  if (!affiliate) return res.redirect('/login');

  try {
    let accountId = affiliate.stripeConnectAccountId;
    if (!accountId) {
      const account = await createAffiliateConnectAccount(affiliate);
      accountId = account.id;
      await prisma.affiliate.update({ where: { id: affiliate.id }, data: { stripeConnectAccountId: accountId } });
    }

    const baseUrl = getBaseUrl(req);
    const url = await createAffiliateOnboardingLink(
      accountId,
      `${baseUrl}/affiliate/connect-stripe/start`, // Stripe sends them back here if the link expires mid-flow
      `${baseUrl}/affiliate/connect-stripe/return`
    );
    res.redirect(url);
  } catch (err) {
    console.error('Stripe Connect onboarding failed to start:', err.message);
    res.redirect(`${dashboardPathFor(affiliate)}?connect_error=1`);
  }
});

router.get('/affiliate/connect-stripe/return', async (req, res) => {
  const affiliate = await getCurrentAffiliate(req);
  if (!affiliate || !affiliate.stripeConnectAccountId) return res.redirect('/login');

  try {
    const status = await getAffiliateConnectStatus(affiliate.stripeConnectAccountId);
    await prisma.affiliate.update({
      where: { id: affiliate.id },
      data: { stripeConnectOnboarded: status.payoutsEnabled },
    });
    // Flush anything that accrued PENDING while this affiliate had no
    // payout account connected yet.
    if (status.payoutsEnabled) {
      await payPendingCommissionsForAffiliate(affiliate.id);
    }
  } catch (err) {
    console.error('Could not confirm Stripe Connect status:', err.message);
  }

  res.redirect(dashboardPathFor(affiliate));
});

module.exports = router;
module.exports.ensureMerchantAffiliate = ensureMerchantAffiliate;
