// routes/customer-payouts.js
// ReceipTap Balance: a host's view of their OWN Stripe Connect balance (the
// same connected account routes/customer-account.js's /account/connect-stripe
// flow creates for Split the Bill), plus withdrawing it. A new file rather
// than appended to customer-account.js's own long list of routes -- same
// per-domain-file convention as routes/loyalty.js, routes/billing.js,
// routes/affiliates.js.
//
// Nothing here ever computes a withdrawable amount from ReceipTap's own
// database -- every balance figure comes live from Stripe's Balance API, per
// the requirement that the ReceipTap split ledger (SplitGroup's
// collected/still-owed) and the Stripe financial balance stay separate
// concepts. See services/stripeService.js's "Host balance / withdrawals"
// section for the Stripe calls themselves.

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const {
  getHostConnectBalance,
  getInstantPayoutEligibility,
  createStandardHostPayout,
  createInstantHostPayout,
} = require('../services/stripeService');
const { parseMoneyToCents } = require('../lib/parseReceiptFields');
const { INSTANT_WITHDRAWAL_FEE_PERCENT } = require('../config/payouts');

function requireCustomerAuth(req, res, next) {
  if (!req.session?.customerId) {
    return res.redirect(`/account/login?redirect=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

function money(cents) {
  return (cents / 100).toFixed(2);
}

// The one currency this app bills/collects in today (see
// services/stripeService.js's createSplitPaymentIntent, which always lowercases
// whatever currency it's given but every caller passes 'usd'/'cad' via the
// receipt's own currency -- balances are read back from Stripe per-currency,
// so this just picks which entry to show first when more than one exists).
function primaryBalanceEntry(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return { amount: 0, currency: 'usd' };
  return entries[0];
}

async function loadOnboardedCustomer(req) {
  const customer = await prisma.customer.findUnique({ where: { id: req.session.customerId } });
  if (!customer || !customer.stripeConnectOnboarded || !customer.stripeConnectAccountId) return null;
  return customer;
}

// PayPal has no equivalent to Stripe's Connect Balance/Payouts API for a
// referred seller -- a guest's PayPal payment routes directly into the
// host's own independent PayPal account (services/paypalService.js's
// createSplitOrder, payee.merchant_id), and PayPal exposes no way for a
// partner platform to read that account's balance or trigger a withdrawal
// from it (the existing onboarding only requests PAYMENT+REFUND checkout
// scopes anyway -- there's no balance/payout scope to even ask for). So
// this is a real total from ReceipTap's OWN payment records (never
// invented), not a live balance, and it's independent of whether Stripe is
// connected -- a host can have either, both, or neither.
async function paypalReceivedCents(customerId) {
  const result = await prisma.splitPayment.aggregate({
    where: { group: { customerId }, method: 'paypal' },
    _sum: { amountCents: true },
  });
  return result._sum.amountCents || 0;
}

router.get('/account/balance', requireCustomerAuth, async (req, res) => {
  const customer = await prisma.customer.findUnique({ where: { id: req.session.customerId } });
  if (!customer) return res.redirect('/account/login');

  const paypalOnboarded = customer.paypalOnboarded;
  const paypalReceived = paypalOnboarded ? await paypalReceivedCents(customer.id) : 0;

  if (!customer.stripeConnectOnboarded || !customer.stripeConnectAccountId) {
    return res.render('account-balance', {
      onboarded: false,
      available: null,
      pending: null,
      recentPayments: [],
      payouts: [],
      showError: req.query.withdraw_error === '1',
      paypalOnboarded,
      paypalReceivedCents: paypalReceived,
      money,
    });
  }

  let balance;
  try {
    balance = await getHostConnectBalance(customer.stripeConnectAccountId);
  } catch (err) {
    console.error('[customer-payouts] balance fetch failed:', err.message);
    balance = null;
  }

  const [recentPayments, payouts] = await Promise.all([
    prisma.splitPayment.findMany({
      where: { group: { customerId: customer.id }, method: 'card' },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.payout.findMany({
      where: { customerId: customer.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  res.render('account-balance', {
    onboarded: true,
    available: balance ? primaryBalanceEntry(balance.available) : null,
    pending: balance ? primaryBalanceEntry(balance.pending) : null,
    balanceError: !balance,
    recentPayments,
    payouts,
    money,
    showError: req.query.withdraw_error === '1',
    paypalOnboarded,
    paypalReceivedCents: paypalReceived,
  });
});

// Polled by account-balance.ejs while the page is open -- same
// fetch-every-few-seconds, JSON-only pattern as
// /account/install/status and /account/receipts/scanned/:id/group/status.
router.get('/account/balance/status', requireCustomerAuth, async (req, res) => {
  const customer = await loadOnboardedCustomer(req);
  if (!customer) return res.json({ onboarded: false });

  let balance;
  try {
    balance = await getHostConnectBalance(customer.stripeConnectAccountId);
  } catch (err) {
    console.error('[customer-payouts] balance status fetch failed:', err.message);
    return res.status(502).json({ onboarded: true, error: true });
  }

  const [recentPayments, payouts] = await Promise.all([
    prisma.splitPayment.findMany({
      where: { group: { customerId: customer.id }, method: 'card' },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.payout.findMany({
      where: { customerId: customer.id },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  const available = primaryBalanceEntry(balance.available);
  const pending = primaryBalanceEntry(balance.pending);

  res.json({
    onboarded: true,
    availableCents: available.amount,
    pendingCents: pending.amount,
    recentPayments: recentPayments.map((p) => ({ id: p.id, amountCents: p.amountCents, createdAt: p.createdAt })),
    payouts: payouts.map((p) => ({
      id: p.id,
      amountCents: p.amountCents,
      method: p.method,
      status: p.status,
      failureReason: p.failureReason,
      createdAt: p.createdAt,
    })),
  });
});

router.get('/account/balance/withdraw', requireCustomerAuth, async (req, res) => {
  const customer = await loadOnboardedCustomer(req);
  if (!customer) return res.redirect('/account/balance');

  let balance;
  try {
    balance = await getHostConnectBalance(customer.stripeConnectAccountId);
  } catch (err) {
    console.error('[customer-payouts] withdraw balance fetch failed:', err.message);
    return res.redirect('/account/balance?withdraw_error=1');
  }

  const available = primaryBalanceEntry(balance.available);

  let instant = { eligible: false, reason: 'Unable to check Instant eligibility right now.' };
  try {
    instant = await getInstantPayoutEligibility(customer.stripeConnectAccountId);
  } catch (err) {
    console.error('[customer-payouts] instant eligibility check failed:', err.message);
  }

  res.render('account-withdraw', {
    availableCents: available.amount,
    currency: available.currency,
    money,
    instant,
    feePercent: INSTANT_WITHDRAWAL_FEE_PERCENT,
    error: req.query.error || null,
  });
});

router.post('/account/balance/withdraw', requireCustomerAuth, async (req, res) => {
  const customer = await loadOnboardedCustomer(req);
  if (!customer) return res.redirect('/account/balance');

  const method = req.body.method === 'instant' ? 'instant' : 'standard';

  try {
    // Always re-fetch the live balance at submit time -- never trust a
    // client-submitted amount for money math, same rule
    // routes/customer-account.js's group/pay route follows.
    const balance = await getHostConnectBalance(customer.stripeConnectAccountId);
    const available = primaryBalanceEntry(balance.available);

    if (method === 'standard') {
      const requestedCents = parseMoneyToCents(req.body.amount);
      if (requestedCents === null || requestedCents <= 0) {
        return res.redirect('/account/balance/withdraw?error=' + encodeURIComponent('Enter a valid amount.'));
      }
      if (requestedCents > available.amount) {
        return res.redirect('/account/balance/withdraw?error=' + encodeURIComponent('That\'s more than your available balance.'));
      }

      const payout = await createStandardHostPayout(customer.stripeConnectAccountId, {
        amountCents: requestedCents,
        currency: available.currency,
      });

      await prisma.payout.create({
        data: {
          customerId: customer.id,
          stripePayoutId: payout.id,
          amountCents: payout.amount,
          currency: payout.currency,
          method: 'standard',
          status: payout.status,
          arrivalDate: payout.arrival_date ? new Date(payout.arrival_date * 1000) : null,
        },
      });
    } else {
      const eligibility = await getInstantPayoutEligibility(customer.stripeConnectAccountId);
      if (!eligibility.eligible) {
        return res.redirect('/account/balance/withdraw?error=' + encodeURIComponent('Instant withdrawal is not available right now.'));
      }

      const { payout, applicationFeeCents } = await createInstantHostPayout(customer.stripeConnectAccountId, {
        currency: available.currency,
      });

      await prisma.payout.create({
        data: {
          customerId: customer.id,
          stripePayoutId: payout.id,
          amountCents: payout.amount,
          currency: payout.currency,
          method: 'instant',
          applicationFeeCents,
          status: payout.status,
          arrivalDate: payout.arrival_date ? new Date(payout.arrival_date * 1000) : null,
        },
      });
    }

    res.redirect('/account/balance?withdrawn=1');
  } catch (err) {
    console.error('[customer-payouts] withdrawal failed:', err.message);
    res.redirect('/account/balance/withdraw?error=' + encodeURIComponent('Withdrawal failed — please try again.'));
  }
});

module.exports = router;
