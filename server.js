// server.js
// The real entry point. Run with: npm start

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const prisma = require('./lib/prisma');

const app = express();

// Railway (like Heroku/Render) terminates HTTPS at its edge and forwards to
// this container over a plain connection. Without telling Express to trust
// that proxy, req.secure is always false, and express-session silently
// refuses to send a Secure session cookie at all -- login "succeeds" but the
// browser never gets a cookie to prove it, so every next request looks
// logged out. Locally (no proxy in front) this line is a no-op.
app.set('trust proxy', 1);

// Safety net: without this, an error that isn't caught anywhere (e.g. a
// transient "can't reach the database" blip during a request) crashes the
// entire Node process and takes the site down for every merchant/customer,
// not just the one request that hit it. Logging and continuing means that
// one request fails, but the server stays up for everyone else.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection (server stayed up):', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server stayed up):', err);
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Stripe and Square webhooks both need the raw, unparsed body for signature
// verification — must be mounted BEFORE express.json() below, or the global
// parser drains the body stream first and verification always fails.
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use('/webhooks/pos/square', express.raw({ type: 'application/json' }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  })
);

// --- Route modules built across this project -------------------------------
const { ownerFlag } = require('./middleware/ownerFlag');
app.use(ownerFlag);
app.use(require('./routes/auth'));           // signup / login / logout
app.use(require('./routes/pucks'));          // /r/:puckId tap routing, /claim/:puckId
app.use(require('./routes/receipt'));        // /receipt/:transactionId
app.use(require('./routes/webhooks'));       // /webhooks/pos/square, /webhooks/pos/clover

// Subscription gate: every /dashboard/* page requires a valid subscription,
// EXCEPT /dashboard/billing itself (blocked merchants need it to re-subscribe)
// and pos-setup's oauth callback flow. Customer wallet (/account/*) is never
// gated — shoppers aren't the ones paying us.
const { requireActiveSubscription } = require('./middleware/subscriptionGate');
app.use('/dashboard', (req, res, next) => {
  if (req.path.startsWith('/billing')) return next(); // billing page always reachable
  if (!req.session?.merchantId) return next();        // let each route's own requireAuth redirect to login
  return requireActiveSubscription(req, res, next);
});

app.use(require('./routes/oauth-square'));   // /oauth/square/connect + callback, /dashboard/pos-setup
app.use(require('./routes/oauth-clover'));   // /oauth/clover/connect + callback, /dashboard/pos-setup/assign-clover
app.use(require('./routes/merchant-dashboard'));  // /dashboard/receipts, /dashboard/receipts-hub
app.use(require('./routes/merchant-expenses'));   // /dashboard/expenses, save-expense
app.use(require('./routes/repeat-customers'));      // /dashboard/repeat-customers, AI-recognized repeat customer analytics + CSV export
app.use(require('./routes/analytics'));              // /dashboard/analytics, stat cards + receipts/POS/customer-growth charts
app.use(require('./routes/pdf-export'));              // /dashboard/receipts/pdf-export, bulk PDF receipt document export
app.use(require('./routes/theme-settings'));       // /dashboard/settings/receipt (Google review link, branding)
app.use(require('./routes/account-settings'));    // /dashboard/settings/account (business info, password, POS disconnect, deactivate)
app.use(require('./routes/email-capture'));         // email/Google capture gate before receipt save, merchant email list
app.use(require('./routes/customer-account'));    // consumer wallet: /account/*
app.use(require('./routes/loyalty'));               // punch cards: join/earn/self-serve redeem, /account/loyalty
app.use(require('./routes/billing'));               // ReceipTap's own subscription billing (Stripe)
app.use(require('./routes/affiliates'));             // referral program: /dashboard/referrals (merchant-affiliates), /affiliate/* (regular affiliates)
app.use(require('./routes/admin'));
app.use(require('./routes/demo'));                    // /demo/receipt -- landing page's auto-scroll showcase

// Root: marketing landing page for visitors, dashboard for logged-in merchants
app.get('/', async (req, res) => {
  if (req.session?.merchantId) return res.redirect('/dashboard/receipts-hub');

  // The hero shows a real rendered receipt (not a mockup) using the founder's
  // own merchant account, so what visitors see is the actual product, not an
  // illustration of it. Falls back to sane defaults if that account is ever
  // renamed or removed, so the marketing page never depends on it existing.
  const demoMerchant = await prisma.merchant.findUnique({ where: { email: 'jordanchimenti98@gmail.com' } });
  const demoTheme = demoMerchant
    ? await prisma.receiptTheme.findUnique({ where: { merchantId: demoMerchant.id } })
    : null;

  res.render('landing', {
    demoMerchant: demoMerchant || { businessName: 'ReceipTap' },
    demoTheme: demoTheme || {
      layoutId: 'classic', logoUrl: null, primaryColor: '#111111', accentColor: '#056BFE',
      location: null, phone: null, gstHstNumber: null, taxLabel: 'Tax', returnPolicy: null, headerText: null,
    },
    demoTransaction: {
      id: 'demo', orderNumber: 'demo',
      lineItems: [
        { name: 'Iced Coffee', quantity: 1, unitPrice: 550, total: 550 },
        { name: 'Blueberry Muffin', quantity: 1, unitPrice: 425, total: 425 },
      ],
      subtotal: '9.75', tax: '1.27', discount: '0.00', total: '11.02',
      paymentMethod: 'Visa ••••4242',
      date: new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
    },
  });
});// 3D scroll experience — brand showcase page
app.get('/experience', (req, res) => {
  res.render('experience');
});

// Affiliate payouts: commissions accumulate as PENDING and go out in a batch
// on each affiliate's own weekly/monthly schedule, not instantly per
// commission. A 6-hour interval is plenty -- runScheduledPayouts only acts
// on affiliates whose cadence (checked in days) has actually come due.
const { runScheduledPayouts } = require('./services/stripeService');
const PAYOUT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
setInterval(() => {
  runScheduledPayouts().catch((err) => console.error('Scheduled affiliate payout run failed:', err));
}, PAYOUT_CHECK_INTERVAL_MS);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ReceipTap backend running on http://localhost:${PORT}`);
});

module.exports = app;