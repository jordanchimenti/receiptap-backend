// server.js
// The real entry point. Run with: npm start

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const compression = require('compression');
const path = require('path');

const app = express();

// Gzips every HTML/CSS/JS/JSON response before it goes out. Nothing here
// used to compress at all -- public/css/receiptap.css (the entire design
// system, per CLAUDE.md) and every server-rendered EJS page went over the
// wire uncompressed, which on a phone connection is the difference between
// one round trip and several. compression() already skips content that's
// already compressed (images, PDFs) via its default filter.
app.use(compression());

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
// Express only turns this on by itself when NODE_ENV=production (here it's
// "development" -- see .env). Off, every single page render re-reads every
// .ejs file (the page itself plus every partial it includes, e.g.
// partials/dashboard-header on every dashboard page) from disk and
// re-compiles it from scratch, SYNCHRONOUSLY -- which blocks the entire
// event loop, not just the request being rendered, so it slows down every
// other in-flight request too, not just the one page. Forcing it on here
// (independent of NODE_ENV, so this doesn't also flip cookie.secure and
// other prod-only behavior below) fixes that without touching anything
// else. Safe with the current workflow either way: `npm run dev` already
// restarts the whole process on file change (node --watch), and the
// long-running `node server.js` instance already needs a restart to pick up
// any edit, cached views or not.
app.set('view cache', true);

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
// Static assets were going out with `max-age=0`, which meant the browser
// re-validated the stylesheet and the logo on EVERY page navigation. On a
// desktop that's invisible; on a phone it's two extra network round trips
// before anything renders, and it was a large part of why the home-screen app
// felt sluggish.
//
// An hour is deliberately modest rather than the usual year: these files have
// no content hash in their names, so a long cache would leave someone looking
// at an old logo with no way to force a refresh. The service worker
// (public/sw.js) caches them properly on top of this.
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders(res, filePath) {
    // The icons are referenced by the manifest and installed once; the HTML
    // itself must never be cached, or a deploy wouldn't reach anyone.
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

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
const { countUnread: countUnreadNotifications } = require('./services/notificationService');
const { countUnread: countUnreadMerchantNotifications } = require('./services/merchantNotificationService');
const { PUBLIC_IMPACT_URL: goodApiPublicImpactUrl } = require('./services/goodApiService');
const pushService = require('./services/pushService');

app.use(ownerFlag);
app.use(require('./routes/auth'));           // signup / login / logout
app.use(require('./routes/legal'));          // /legal/terms, /legal/privacy, /legal/dpa -- stub pages linked from signup
app.use(require('./routes/pucks'));          // /r/:puckId tap routing, /claim/:puckId
app.use(require('./routes/receipt'));        // /receipt/:transactionId
app.use(require('./routes/receiptShare'));   // /share/receipt/:token -- scanned-receipt share links
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
// The wallet now has its own billing page (GET /account/business/billing),
// so it gets the same /billing exception /dashboard has -- without it the
// subscription gate bounced a blocked merchant to billing on a page that
// was itself gated, dumping them out of the wallet and onto the navy
// dashboard on the first load after login.
app.use('/account/business', (req, res, next) => {
  if (!req.session?.merchantId) return next();
  return requireDemoAccess(req, res, next);
});
app.use('/account/business', (req, res, next) => {
  if (req.path.startsWith('/billing')) return next(); // billing page always reachable
  // Partner Program exception, matching /dashboard/referrals above: it's free
  // to join and free to earn from, so a lapsed merchant still reaches their
  // referral link and commission history here instead of being sent to billing.
  if (req.path.startsWith('/referrals')) return next();
  if (!req.session?.merchantId) return next();
  return requireActiveSubscription(req, res, next);
});
app.use('/account/business', (req, res, next) => {
  if (req.path.startsWith('/billing')) return next(); // same reason as /dashboard's legal gate
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
// The wallet's bottom bar shows an unread count on the Alerts tab, and that
// bar is on every wallet page -- so resolve it once here rather than making
// each route remember to fetch it. Signed-out requests and non-wallet paths
// skip the query entirely.
app.use('/account', async (req, res, next) => {
  // Business pages have their own unread-count middleware right below --
  // skip entirely rather than let this one ALSO wrap res.render for them.
  // /account is a prefix of /account/business, so without this check both
  // middlewares would chain on every business page, and a merchant who is
  // ALSO a wallet customer with unread personal alerts could see THAT count
  // bleed onto their business Notifications tab whenever their own business
  // count happened to be exactly zero (see the code comment on the business
  // middleware for exactly why that race exists).
  if (req.path.startsWith('/business')) return next();

  res.locals.unreadCount = 0;
  // Every wallet page can offer the notification switch, so the keys go on
  // locals here rather than being threaded through each route individually.
  res.locals.pushConfigured = pushService.isPushConfigured();
  res.locals.pushPublicKey = pushService.publicKey();
  if (!req.session?.customerId) return next();

  // Started here but NOT awaited. Awaiting would put a full database round
  // trip (~26ms) in front of every wallet page before the route had even begun
  // its own queries. Kicking it off now and collecting it at render time lets
  // it run alongside them instead, so the badge costs nothing it doesn't have
  // to.
  const pending = countUnreadNotifications(req.session.customerId).catch((err) => {
    // A badge is not worth failing a page load over.
    console.error('[wallet] unread notification count failed:', err.message);
    return 0;
  });

  const render = res.render.bind(res);
  res.render = function (view, options, callback) {
    pending.then((count) => {
      // A route that already set this (the Alerts tab clears its own badge)
      // wins -- it knows something this query can't.
      if (res.locals.unreadCount === 0) res.locals.unreadCount = count;
      render(view, options, callback);
    });
  };

  next();
});

app.use(require('./routes/customer-account'));    // consumer wallet: /account/*

// Same shape as the customer unread-count middleware above, kept entirely
// separate (see that middleware's comment on /business) rather than shared,
// since a merchant and customer session are different logins with different
// unread counts even when it's the same person signed into both.
app.use('/account/business', async (req, res, next) => {
  res.locals.unreadCount = 0;
  if (!req.session?.merchantId) return next();

  const pending = countUnreadMerchantNotifications(req.session.merchantId).catch((err) => {
    console.error('[business] unread notification count failed:', err.message);
    return 0;
  });

  const render = res.render.bind(res);
  res.render = function (view, options, callback) {
    pending.then((count) => {
      if (res.locals.unreadCount === 0) res.locals.unreadCount = count;
      render(view, options, callback);
    });
  };

  next();
});
app.use(require('./routes/account-business'));    // wallet's dark reskin of the merchant dashboard: /account/business/*
app.use(require('./routes/loyalty'));               // punch cards: join/earn/self-serve redeem, /account/loyalty
app.use(require('./routes/billing'));               // ReceipTap's own subscription billing (Stripe)
app.use(require('./routes/affiliates'));             // referral program: /dashboard/referrals (merchant-affiliates), /affiliate/* (regular affiliates)
app.use(require('./routes/admin'));
app.use(require('./routes/demo'));                    // /demo/receipt -- landing page's auto-scroll showcase

// Root: marketing landing page for visitors, dashboard for logged-in merchants
app.get('/', (req, res) => {
  if (req.session?.merchantId) return res.redirect('/account/business');
  res.render('landing', { goodApiImpactUrl: goodApiPublicImpactUrl });
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
const { purgeExpiredReceipts, purgeExpiredScannedReceipts, purgeDeactivatedMerchants, purgeAbandonedScanUploads } = require('./services/dataRetentionService');
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
    const scannedReceipts = await purgeExpiredScannedReceipts({ dryRun });
    const merchants = await purgeDeactivatedMerchants({ dryRun });
    console.log('[retention] purgeExpiredReceipts:', JSON.stringify(receipts.details), receipts.error || '');
    console.log('[retention] purgeExpiredScannedReceipts:', JSON.stringify(scannedReceipts.details), scannedReceipts.error || '');
    console.log('[retention] purgeDeactivatedMerchants:', JSON.stringify(merchants.details), merchants.error || '');
    const scans = await purgeAbandonedScanUploads({ dryRun });
    console.log('[retention] purgeAbandonedScanUploads:', JSON.stringify(scans.details), scans.error || '');
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

// Warranty reminders: same interval-on-boot shape as retention purge above,
// as its own independent timer. WARRANTY_REMINDERS_ENABLED gates actually
// sending -- unset (or anything but the literal string "true") keeps every
// run in dry-run (log what WOULD be sent, notify nobody, stamp nothing),
// same "new automated job ships off by default" convention as
// RETENTION_PURGE_ENABLED. There is no way to go live except by explicitly
// setting this in the environment.
const { sendDueWarrantyReminders } = require('./services/warrantyReminderService');
const WARRANTY_REMINDERS_ENABLED = process.env.WARRANTY_REMINDERS_ENABLED === 'true';
const WARRANTY_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const WARRANTY_REMINDER_BOOT_DELAY_MS = 90 * 1000; // stagger past the retention purge's own boot delay

let warrantyReminderRunning = false;

async function runWarrantyReminders() {
  if (warrantyReminderRunning) {
    console.warn('[warranty] previous reminder run still in progress -- skipping this tick');
    return;
  }
  warrantyReminderRunning = true;
  try {
    const dryRun = !WARRANTY_REMINDERS_ENABLED;
    console.log(`[warranty] starting daily reminder run (dryRun: ${dryRun})`);
    const result = await sendDueWarrantyReminders({ dryRun });
    console.log('[warranty] sendDueWarrantyReminders:', JSON.stringify(result.details), result.error || '');
  } catch (err) {
    console.error('[warranty] daily reminder run failed:', err);
  } finally {
    warrantyReminderRunning = false;
  }
}

setTimeout(() => {
  runWarrantyReminders().catch((err) => console.error('[warranty] unexpected error:', err));
  setInterval(() => {
    runWarrantyReminders().catch((err) => console.error('[warranty] unexpected error:', err));
  }, WARRANTY_REMINDER_INTERVAL_MS);
}, WARRANTY_REMINDER_BOOT_DELAY_MS);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  require('./lib/fileStorage').assertProductionStorage();
  console.log(`ReceipTap backend running on http://localhost:${PORT}`);
});

module.exports = app;