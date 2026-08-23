// routes/affiliates.js
// The referral/commission program. Two kinds of affiliate share one table:
//   MERCHANT — an existing merchant referring others, earning while their own
//     subscription is ACTIVE. No separate login -- reuses their merchant
//     session via Merchant.ownAffiliateAccount.
//   REGULAR  — a standalone affiliate (e.g. future sales team) with their
//     own signup/login, not tied to a Merchant account.
// It's one program at one flat rate to the outside world (see
// services/affiliateRates.js) -- the two types are only about how someone
// logs in and whether their own subscription gates accrual.
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
  getSubscriptionPrice,
} = require('../services/stripeService');
const { MERCHANT_AFFILIATE_RATE, REGULAR_AFFILIATE_RATE } = require('../services/affiliateRates');
const { getBaseUrl } = require('../lib/baseUrl');
const { affiliateReturnPath } = require('../lib/affiliateReturnPath');
const { normalizeEmail } = require('../lib/normalizeEmail');
const { generateAffiliateInvoicePDF } = require('../services/generate-affiliate-invoice-pdf');

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

// Every merchant is in the Partner Program without a separate signup step
// (and without a subscription -- it's free to join and free to earn from) --
// this lazily creates their MERCHANT-type affiliate row (and referral code)
// the first time it's needed, whether that's them visiting their own
// dashboard or turning on the receipt banner in Settings.
// Exported so other routes (theme-settings.js) can reuse it.
async function ensureMerchantAffiliate(merchantId) {
  let affiliate = await prisma.affiliate.findUnique({ where: { merchantId } });
  if (!affiliate) {
    const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
    affiliate = await prisma.affiliate.create({
      data: {
        name: merchant.ownerName || merchant.businessName,
        email: normalizeEmail(merchant.email),
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

// Shared shape for both dashboards -- fetches referred merchants + commissions.
// No eligibility flag: joining and earning are free, with no subscription
// requirement on the affiliate's own account.
async function buildAffiliateView(affiliate) {
  const [referredMerchants, commissions, price] = await Promise.all([
    prisma.merchant.findMany({
      where: { referredByAffiliateId: affiliate.id },
      select: { id: true, businessName: true, subscriptionStatus: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.commission.findMany({
      where: { affiliateId: affiliate.id },
      include: { merchant: { select: { businessName: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    getSubscriptionPrice(),
  ]);

  const rate = affiliate.type === 'MERCHANT' ? MERCHANT_AFFILIATE_RATE : REGULAR_AFFILIATE_RATE;

  // Forward-looking, not historical: what this affiliate stands to earn
  // EVERY month going forward at today's rate and referral count, not what
  // they've already been paid (paidTotal, below) or what's sitting PENDING
  // from a one-time charge like the ReceipTap puck's shipping fee. Only
  // ACTIVE referrals count -- a TRIALING one hasn't started its recurring
  // billing yet, and a PAST_DUE one isn't successfully recurring right now
  // either, same "is this actually paying" bar hasAccess() uses elsewhere.
  // null (not $0.00) when there's no real subscription price to multiply by
  // yet (Stripe not configured), same reasoning as churnRate's null case.
  const activeReferralCount = referredMerchants.filter((m) => m.subscriptionStatus === 'ACTIVE').length;
  const monthlyRecurringCommission = price
    ? ((activeReferralCount * parseFloat(price.amount) * rate) / 100).toFixed(2)
    : null;

  // Still loaded for ownSubscriptionStatus/isDemoAccount below, but NOT to
  // decide whether they earn: the Partner Program is free, so a merchant
  // accrues commission on their referrals whether or not their own
  // subscription is active (see recordAffiliateCommission in services/stripeService.js).
  let ownMerchant = null;
  if (affiliate.type === 'MERCHANT') {
    ownMerchant = await prisma.merchant.findUnique({ where: { id: affiliate.merchantId } });
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
    ownSubscriptionStatus: ownMerchant?.subscriptionStatus || null,
    isDemoAccount: ownMerchant?.isDemoAccount || false,
    stripeConnectOnboarded: affiliate.stripeConnectOnboarded,
    payoutFrequency: affiliate.payoutFrequency,
    churnRate,
    activeReferralCount,
    monthlyRecurringCommission,
    referredMerchants: referredMerchants.map((m) => ({
      businessName: m.businessName,
      subscriptionStatus: m.subscriptionStatus,
      joinedAt: m.createdAt.toLocaleDateString('en-US', { dateStyle: 'medium' }),
    })),
    commissions: commissions.map((c) => ({
      id: c.id,
      amount: (c.amountCents / 100).toFixed(2),
      rate: c.rate,
      status: c.status,
      date: c.createdAt.toLocaleDateString('en-US', { dateStyle: 'medium' }),
      merchantName: c.merchant.businessName,
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
    redirectTo: '/dashboard/referrals',
  });
});

// A downloadable PDF invoice for one PAID commission -- works for whichever
// session type is present (merchant-affiliate or standalone affiliate),
// same as the rest of this file. Ownership is checked against the
// commission's own affiliateId, not just "is someone logged in", since a
// commission ID is a guessable/enumerable cuid, not a secret token. Only
// PAID commissions get an invoice -- a PENDING one is a promise, not yet a
// real payment, so there's nothing true to invoice for it yet.
router.get('/affiliate/commissions/:id/invoice', async (req, res) => {
  const affiliate = await getCurrentAffiliate(req);
  if (!affiliate) return res.redirect('/login');

  const commission = await prisma.commission.findUnique({
    where: { id: req.params.id },
    include: { merchant: { select: { businessName: true } } },
  });
  if (!commission || commission.affiliateId !== affiliate.id) {
    return res.status(404).send('Invoice not found.');
  }
  if (commission.status !== 'PAID') {
    return res.status(400).send("This commission hasn't been paid out yet.");
  }

  let buffer;
  try {
    buffer = await generateAffiliateInvoicePDF(commission, affiliate, commission.merchant.businessName);
  } catch (err) {
    console.error('Affiliate invoice PDF generation failed:', err.message);
    return res.status(500).send('Failed to generate invoice. Please try again in a moment.');
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="receiptap-invoice-${commission.id.slice(-8)}.pdf"`);
  res.send(buffer);
});

// --- Earnings projection shown on the public Partner Program page ---------

// "If N merchants subscribe from your link, you make this much." Deliberately
// derived from the live Stripe price rather than a hardcoded number, so the
// page can't quietly go stale the day the subscription price changes -- and
// null (not $0) when Stripe isn't configured, so the section is dropped
// rather than shown as a wrong number. Same reasoning as
// monthlyRecurringCommission's null case in buildAffiliateView above.
const REFERRAL_MILESTONES = [10, 50, 100, 500, 1000];

// How many billing periods a year, so the "per year" column is right even if
// the subscription price is ever switched off a monthly interval.
const PERIODS_PER_YEAR = { day: 365, week: 52, month: 12, year: 1 };

function buildEarningsProjection(price, rate) {
  if (!price) return null;

  const money = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: price.currency,
    maximumFractionDigits: 0,
  });
  const exactMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: price.currency });

  // Round to whole cents FIRST, then multiply -- that's the order
  // recordAffiliateCommission() uses on each individual invoice
  // (Math.round(invoice.amount_paid * rate/100), services/stripeService.js),
  // so these projections are exactly N times a real payout rather than a
  // float that drifts a couple of dollars by the 1,000-referral row.
  const priceCents = Math.round(parseFloat(price.amount) * 100);
  const perReferralCents = Math.round((priceCents * rate) / 100);
  const periods = PERIODS_PER_YEAR[price.interval] || 12;

  // How many referrals it takes for commission to cover the referrer's own
  // subscription. Derived, not hardcoded: at today's numbers it's 5, but a
  // price change would quietly make a literal "5" a false claim on a public
  // page. Guarded against a 0% rate so it can't divide by zero.
  const breakEvenCount = perReferralCents > 0 ? Math.ceil(priceCents / perReferralCents) : null;

  return {
    interval: price.interval,
    // Surfaced so the page can label the columns with the real currency
    // rather than leaving a bare "$" to be read as CAD/AUD/etc.
    currency: price.currency,
    breakEvenCount,
    breakEvenEarnings: breakEvenCount ? money.format((perReferralCents * breakEvenCount) / 100) : null,
    subscriptionPrice: exactMoney.format(priceCents / 100),
    perReferral: exactMoney.format(perReferralCents / 100),
    rows: REFERRAL_MILESTONES.map((count) => ({
      count: count.toLocaleString('en-US'),
      perPeriod: money.format((perReferralCents * count) / 100),
      perYear: money.format((perReferralCents * count * periods) / 100),
    })),
  };
}

// --- Public landing page -- one program, one page, no login required ---

// There is no longer a separate merchant vs. standalone-affiliate landing
// page: both earn the same flat rate, so one page covers the whole program
// and just points each visitor at the right way in (dashboard vs. signup).
//
// It's also reachable from inside a merchant session (the wallet's Business
// > More > Partner Program row), so when a merchant is logged in the CTAs
// point at their own referral link instead of a signup they don't need.
// `?from=` says which Partner Program surface they came from -- same
// two-surfaces problem lib/affiliateReturnPath.js already solves for every
// other redirect, and validated by the same allowlist rather than trusted.
router.get('/partner-program', async (req, res) => {
  const price = await getSubscriptionPrice();
  const isMerchant = Boolean(req.session?.merchantId);
  const isCustomer = Boolean(req.session?.customerId);

  res.render('partner-program', {
    rate: REGULAR_AFFILIATE_RATE,
    isMerchant,
    dashboardPath: affiliateReturnPath(req.query.from),
    // Shoppers reach this page from the setup checklist in their wallet, and
    // running from the home screen they have no browser back button -- without
    // a way back this page is a dead end for them exactly as it was for
    // merchants. Their return path is the wallet, not a merchant surface.
    showBack: isMerchant || isCustomer,
    backPath: isMerchant ? affiliateReturnPath(req.query.from) : '/account/receipts',
    earnings: buildEarningsProjection(price, REGULAR_AFFILIATE_RATE),
  });
});

// The two old per-program URLs are live in the wild (receipt banners, links
// people already shared), so keep them working instead of 404ing.
router.get('/partner-program/merchant', (req, res) => res.redirect(301, '/partner-program'));
router.get('/partner-program/affiliate', (req, res) => res.redirect(301, '/partner-program'));

// --- Regular affiliate: standalone signup/login --------------------------

router.get('/affiliate/signup', (req, res) => res.render('affiliate-signup', { error: null, rate: REGULAR_AFFILIATE_RATE }));
router.get('/affiliate/login', (req, res) => res.render('affiliate-login', {
  error: null,
  redirect: req.query.redirect || '/affiliate/dashboard',
}));

router.post('/affiliate/signup', async (req, res) => {
  const { name, email: rawEmail, password } = req.body;
  const email = normalizeEmail(rawEmail);
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
  const { email: rawEmail, password } = req.body;
  const email = normalizeEmail(rawEmail);
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
    // One program, one label -- the affiliate's type only decides how they
    // log in and whether accrual is gated, not what program they're in.
    programName: 'Partner Program',
    affiliateName: affiliate.name,
    referralUrl: `${getBaseUrl(req)}/signup?ref=${view.referralCode}`,
    connectError: req.query.connect_error === '1',
    codeError: req.query.code_error || null,
    codeSuccess: req.query.code_success === '1',
  });
});

// `redirectTo` only matters for a MERCHANT-type affiliate -- a regular
// affiliate has exactly one dashboard, so there's nowhere else to return to.
// Where to send someone who has to sign in before we can finish. The two
// affiliate types authenticate in completely different places -- a MERCHANT
// partner signs in with their business account, a REGULAR partner has a
// standalone partner account -- so a single `/login` fallback sent half of
// them to a page their password doesn't work on.
//
// `returnTo` is carried through so they resume where they were interrupted
// instead of landing on a dashboard and having to find their way back.
function loginPathFor(type, returnTo) {
  const base = type === 'MERCHANT' ? '/login' : '/affiliate/login';
  return returnTo ? `${base}?redirect=${encodeURIComponent(returnTo)}` : base;
}

function dashboardPathFor(affiliate, redirectTo) {
  return affiliate.type === 'MERCHANT' ? affiliateReturnPath(redirectTo) : '/affiliate/dashboard';
}

// How often accumulated commissions get paid out -- doesn't trigger anything
// itself, just changes what runScheduledPayouts (services/stripeService.js)
// picks up on its next check.
router.post('/affiliate/payout-frequency', async (req, res) => {
  const affiliate = await getCurrentAffiliate(req);
  if (!affiliate) return res.redirect('/login');

  const safeFrequency = req.body.payoutFrequency === 'MONTHLY' ? 'MONTHLY' : 'WEEKLY';
  await prisma.affiliate.update({ where: { id: affiliate.id }, data: { payoutFrequency: safeFrequency } });

  res.redirect(dashboardPathFor(affiliate, req.body.redirectTo));
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

  const backTo = dashboardPathFor(affiliate, req.body.redirectTo);
  const requested = (req.body.referralCode || '').trim().toUpperCase();

  if (!CUSTOM_CODE_PATTERN.test(requested)) {
    return res.redirect(
      `${backTo}?code_error=${encodeURIComponent('Your link can only use letters and numbers, 3-20 characters.')}`
    );
  }
  if (RESERVED_REFERRAL_CODES.has(requested)) {
    return res.redirect(
      `${backTo}?code_error=${encodeURIComponent('That code is reserved -- please choose another.')}`
    );
  }
  if (requested === affiliate.referralCode) {
    return res.redirect(backTo); // unchanged, nothing to do
  }

  const existing = await prisma.affiliate.findUnique({ where: { referralCode: requested } });
  if (existing) {
    return res.redirect(
      `${backTo}?code_error=${encodeURIComponent('That link is already taken -- please choose another.')}`
    );
  }

  await prisma.affiliate.update({ where: { id: affiliate.id }, data: { referralCode: requested } });
  res.redirect(`${backTo}?code_success=1`);
});

// --- Stripe Connect onboarding (shared by both affiliate types) -----------
// The affiliate never enters bank/ID details into this app -- they're sent
// to a Stripe-hosted page that collects that directly, and Stripe redirects
// back here afterward. Works for whichever session type is present.

router.get('/affiliate/connect-stripe/start', async (req, res) => {
  const affiliate = await getCurrentAffiliate(req);
  // No session at all: a merchant session is the only one that could have
  // reached this link, so the business login is the right guess here.
  if (!affiliate) return res.redirect(loginPathFor('MERCHANT', req.originalUrl));

  // Validated once here rather than trusted as-is on the way back out --
  // these become Stripe-hosted URLs we don't control the query string of
  // once the affiliate is on Stripe's site, same reasoning as
  // lib/posReturnPath.js's OAuth `state` round-trip.
  const next = affiliateReturnPath(req.query.next);

  try {
    let accountId = affiliate.stripeConnectAccountId;
    if (!accountId) {
      const account = await createAffiliateConnectAccount(affiliate);
      accountId = account.id;
      await prisma.affiliate.update({ where: { id: affiliate.id }, data: { stripeConnectAccountId: accountId } });
    }

    const baseUrl = getBaseUrl(req);
    // The affiliate's TYPE rides along to Stripe and back. It's only ever used
    // to choose which login screen to show if the session didn't survive the
    // round trip -- it identifies nobody and grants nothing, and it's checked
    // against the two known values on the way back rather than trusted.
    const as = affiliate.type === 'MERCHANT' ? 'MERCHANT' : 'REGULAR';
    const query = `next=${encodeURIComponent(next)}&as=${as}`;
    const url = await createAffiliateOnboardingLink(
      accountId,
      `${baseUrl}/affiliate/connect-stripe/start?${query}`, // Stripe sends them back here if the link expires mid-flow
      `${baseUrl}/affiliate/connect-stripe/return?${query}`
    );
    res.redirect(url);
  } catch (err) {
    console.error('Stripe Connect onboarding failed to start:', err.message);
    res.redirect(`${dashboardPathFor(affiliate, next)}?connect_error=1`);
  }
});

router.get('/affiliate/connect-stripe/return', async (req, res) => {
  const affiliate = await getCurrentAffiliate(req);

  // Coming back from a Stripe-hosted page, the session sometimes isn't there
  // -- a different browser finished the flow, or the cookie didn't survive the
  // round trip. Send them to the login their account actually uses, and bring
  // them straight back here afterwards so the Connect status still gets
  // confirmed rather than silently skipped.
  if (!affiliate || !affiliate.stripeConnectAccountId) {
    const as = req.query.as === 'MERCHANT' ? 'MERCHANT' : 'REGULAR';
    const next = affiliateReturnPath(req.query.next);
    const resume = `/affiliate/connect-stripe/return?next=${encodeURIComponent(next)}&as=${as}`;
    return res.redirect(loginPathFor(as, resume));
  }

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

  res.redirect(dashboardPathFor(affiliate, req.query.next));
});

module.exports = router;
module.exports.ensureMerchantAffiliate = ensureMerchantAffiliate;
module.exports.getCurrentAffiliate = getCurrentAffiliate;
module.exports.buildAffiliateView = buildAffiliateView;
