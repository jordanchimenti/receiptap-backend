// server.js
// The real entry point. Run with: npm start

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

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

// Stripe, Square, Lightspeed, and Shopify webhooks all need the raw,
// unparsed body for signature verification — must be mounted BEFORE
// express.json() below, or the global parser drains the body stream first
// and verification always fails. Clover doesn't need this (its auth is a
// plain header compare, not an HMAC over the body).
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use('/webhooks/pos/square', express.raw({ type: 'application/json' }));
app.use('/webhooks/pos/lightspeed', express.raw({ type: 'application/json' }));
app.use('/webhooks/pos/shopify', express.raw({ type: 'application/json' }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Sessions live in Postgres, through the app's own Prisma connection
// (lib/prismaSessionStore.js). With the default MemoryStore every restart --
// a deploy, a crash, a watch reload -- signed out every merchant and shopper
// at once, and on more than one instance a request could land on a container
// that had never seen the session.
//
// Deliberately NOT connect-pg-simple: it opens a second Postgres pool, and
// Supabase's session-mode pooler caps at 15 clients for everything combined.
// That cap was hit, session writes failed with EMAXCONNSESSION, and login
// broke silently -- express-session treats a failed save as non-fatal, so the
// redirect succeeded and the session simply wasn't there on the next request.
// 400 days -- the ceiling browsers actually honour. Chrome clamps any cookie
// expiry beyond 400 days (RFC 6265bis), so asking for longer just gets
// silently truncated. Paired with `rolling` below, this means "stay signed in
// as long as you use ReceipTap at least once a year".
const SESSION_TTL_MS = 400 * 24 * 60 * 60 * 1000;
const { PrismaSessionStore } = require('./lib/prismaSessionStore');
app.use(
  session({
    store: new PrismaSessionStore({ ttlMs: SESSION_TTL_MS }),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    // Without this, the clock starts at FIRST login and never restarts -- a
    // shopper tapping every week was still signed out on day 30. Rolling
    // re-issues the cookie on each visit, so the window is measured from last
    // use, which is what "stay signed in" is supposed to mean.
    rolling: true,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      maxAge: SESSION_TTL_MS,
      httpOnly: true,
      sameSite: 'lax',
    },
  })
);// --- Route modules built across this project -------------------------------
const { ownerFlag } = require('./middleware/ownerFlag');
app.use(ownerFlag);
app.use(require('./routes/auth'));           // signup / login / logout
app.use(require('./routes/legal'));          // /legal/terms, /legal/privacy, /legal/dpa -- stub pages linked from signup
app.use(require('./routes/pucks'));          // /r/:puckId tap routing, /claim/:puckId
app.use(require('./routes/receipt'));        // /receipt/:transactionId
app.use(require('./routes/webhooks'));       // /webhooks/pos/square, /webhooks/pos/clover, /webhooks/pos/lightspeed, /webhooks/pos/shopify

// Demo-account gate: a free, no-card merchant (Merchant.isDemoAccount) can
// only reach receipt design and billing (to upgrade) -- everything else on
// /dashboard redirects there. Mounted before the subscription gate below,
// which separately knows to skip its own check for demo accounts so the two
// don't fight over the same request -- see middleware/demoAccountGate.js.
const { requireDemoAccess } = require('./middleware/demoAccountGate');
app.use('/dashboard', (req, res, next) => {
  if (!req.session?.merchantId) return next();
  return requireDemoAccess(req, res, next);
});

// Subscription gate: every /dashboard/* page requires a valid subscription,
// EXCEPT /dashboard/billing itself (blocked merchants need it to re-subscribe),
// /dashboard/referrals (the Partner Program is free -- see below), and
// pos-setup's oauth callback flow. Customer wallet (/account/*) is never
// gated — shoppers aren't the ones paying us.
const { requireActiveSubscription } = require('./middleware/subscriptionGate');
app.use('/dashboard', (req, res, next) => {
  if (req.path.startsWith('/billing')) return next(); // billing page always reachable
  // The Partner Program costs nothing to join and nothing to earn from, so a
  // merchant whose own subscription lapsed still reaches their referral link
  // and commission history instead of being bounced to billing. The wallet's
  // equivalent (/account/business/referrals) needs the same exception on its
  // own gate below -- /account/business has its own copy of these three gates.
  if (req.path.startsWith('/referrals')) return next();
  if (!req.session?.merchantId) return next();        // let each route's own requireAuth redirect to login
  return requireActiveSubscription(req, res, next);
});

// Legal re-acceptance gate: runs after the subscription gate (a merchant who
// can't pay shouldn't be stopped on a legal screen before they can even
// reach billing), same /billing exception, same ordering constraint as
// ownerFlag above -- mounted after it, per CLAUDE.md's mount-order gotcha.
const { requireCurrentLegalAcceptance } = require('./middleware/legalReacceptance');
app.use('/dashboard', (req, res, next) => {
  if (req.path.startsWith('/billing')) return next();
  if (!req.session?.merchantId) return next();
  return requireCurrentLegalAcceptance(req, res, next);
});

// Same three gates as /dashboard above, wrapped around /account/business
// (the wallet's dark reskin of the dashboard, routes/account-business.js)
// so this second entry point into merchant data can't show a demo or
// canceled-subscription merchant anything the real dashboard wouldn't.
// No /billing exception here -- Phase 1 has no billing page in the wallet
// yet, so a blocked merchant lands on the real /dashboard/billing instead.
app.use('/account/business', (req, res, next) => {
  if (!req.session?.merchantId) return next();
  return requireDemoAccess(req, res, next);
});
app.use('/account/business', (req, res, next) => {
  // Partner Program exception, matching /dashboard/referrals above: it's free
  // to join and free to earn from, so a lapsed merchant still reaches their
  // referral link and commission history here instead of being sent to billing.
  if (req.path.startsWith('/referrals')) return next();
  if (!req.session?.merchantId) return next();
  return requireActiveSubscription(req, res, next);
});
app.use('/account/business', (req, res, next) => {
  if (!req.session?.merchantId) return next();
  return requireCurrentLegalAcceptance(req, res, next);
});

app.use(require('./routes/oauth-square'));   // /oauth/square/connect + callback, /dashboard/pos-setup
app.use(require('./routes/oauth-clover'));   // /oauth/clover/connect + callback, /dashboard/pos-setup/assign-clover
app.use(require('./routes/oauth-lightspeed')); // /oauth/lightspeed/connect + callback, /dashboard/pos-setup/assign-lightspeed
app.use(require('./routes/oauth-shopify'));    // /oauth/shopify/connect + callback, /dashboard/pos-setup/assign-shopify
app.use(require('./routes/merchant-dashboard'));  // /dashboard/receipts, /dashboard/receipts-hub
app.use(require('./routes/merchant-expenses'));   // /dashboard/expenses, save-expense
app.use(require('./routes/repeat-customers'));      // /dashboard/repeat-customers, AI-recognized repeat customer analytics + CSV export
app.use(require('./routes/analytics'));              // /dashboard/analytics, stat cards + receipts/POS/customer-growth charts
app.use(require('./routes/pdf-export'));              // /dashboard/receipts/pdf-export, bulk PDF receipt document export
app.use(require('./routes/theme-settings'));       // /dashboard/settings/receipt (Google review link, branding)
app.use(require('./routes/account-settings'));    // /dashboard/settings/account (business info, password, POS disconnect, deactivate)
app.use(require('./routes/email-capture'));         // email/Google capture gate before receipt save, merchant email list
app.use(require('./routes/customer-account'));    // consumer wallet: /account/*
app.use(require('./routes/account-business'));    // wallet's dark reskin of the merchant dashboard: /account/business/*
app.use(require('./routes/loyalty'));               // punch cards: join/earn/self-serve redeem, /account/loyalty
app.use(require('./routes/billing'));               // ReceipTap's own subscription billing (Stripe)
app.use(require('./routes/affiliates'));             // referral program: /dashboard/referrals (merchant-affiliates), /affiliate/* (regular affiliates)
app.use(require('./routes/admin'));
app.use(require('./routes/demo'));                    // /demo/receipt -- landing page's auto-scroll showcase

// Root: marketing landing page for visitors, dashboard for logged-in merchants
app.get('/', (req, res) => {
  if (req.session?.merchantId) return res.redirect('/dashboard/receipts-hub');
  res.render('landing');
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

// Retention purge: enforces config/retention.js daily. No Railway cron
// service is configured for this app (single `node server.js` process, no
// railway.json/Procfile) -- same interval-on-boot approach as the payout
// scheduler above, not a real distributed cron. See CLAUDE.md for the
// tradeoff this implies if the app is ever scaled to multiple instances.
//
// RETENTION_PURGE_ENABLED gates LIVE deletion. Unset (or anything other
// than the literal string "true") keeps every run in dry-run mode
// regardless of dataRetentionService's own default -- there is no way to
// go live except by explicitly setting this in the environment.
const { purgeExpiredReceipts, purgeDeactivatedMerchants } = require('./services/dataRetentionService');
const RETENTION_PURGE_ENABLED = process.env.RETENTION_PURGE_ENABLED === 'true';
const RETENTION_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const RETENTION_PURGE_BOOT_DELAY_MS = 60 * 1000; // let the app finish starting up first

// In-memory only -- sufficient because this runs as a single process, not
// a real lock against another instance also running this same job. Guards
// against the (currently impossible, but cheap to guard anyway) case of a
// run still in progress when the next interval tick fires.
let retentionPurgeRunning = false;

async function runRetentionPurge() {
  if (retentionPurgeRunning) {
    console.warn('[retention] previous purge run still in progress -- skipping this tick');
    return;
  }
  retentionPurgeRunning = true;
  try {
    const dryRun = !RETENTION_PURGE_ENABLED;
    console.log(`[retention] starting daily purge run (dryRun: ${dryRun})`);
    const receipts = await purgeExpiredReceipts({ dryRun });
    const merchants = await purgeDeactivatedMerchants({ dryRun });
    console.log('[retention] purgeExpiredReceipts:', JSON.stringify(receipts.details), receipts.error || '');
    console.log('[retention] purgeDeactivatedMerchants:', JSON.stringify(merchants.details), merchants.error || '');
  } catch (err) {
    console.error('[retention] daily purge run failed:', err);
  } finally {
    retentionPurgeRunning = false;
  }
}

setTimeout(() => {
  runRetentionPurge().catch((err) => console.error('[retention] unexpected error:', err));
  setInterval(() => {
    runRetentionPurge().catch((err) => console.error('[retention] unexpected error:', err));
  }, RETENTION_PURGE_INTERVAL_MS);
}, RETENTION_PURGE_BOOT_DELAY_MS);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ReceipTap backend running on http://localhost:${PORT}`);
});

module.exports = app;