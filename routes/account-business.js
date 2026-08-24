// routes/account-business.js
// Phase 1 of the wallet's dark "Business" section (see
// /Users/jordanchimenti/.claude/plans/sunny-conjuring-bumblebee.md) --
// the read-heavy half of the real merchant dashboard, restyled to match
// the customer wallet's dark theme and reached through
// views/account-more.ejs's Personal/Business toggle. This is a SECOND
// entry point into the exact same merchant data the navy-sidebar
// dashboard already shows at /dashboard/* -- every data-fetching function
// below is imported from the existing route files, not re-derived, so the
// two surfaces can never quietly disagree about a number.
//
// Auth: same requireAuth check every /dashboard/* route uses
// (req.session.merchantId) -- a merchant session is already the real
// authority over this data. server.js wraps /account/business with the
// same demo-account/subscription/legal-reacceptance gates /dashboard has,
// so this side door can't show a canceled or demo-restricted merchant
// anything the front door wouldn't.

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { deleteShopperByEmail } = require('../services/dataRetentionService');
const { DEACTIVATED_MERCHANT_PURGE_DAYS } = require('../config/retention');
const claimLimit = require('../lib/claimAttemptLimit');

const { computeOverviewData, computeReceiptsHubData, computePucksData } = require('./merchant-dashboard');
const { computeAnalyticsData } = require('./analytics');
const { computeRepeatCustomersData } = require('./repeat-customers');
const { computeCustomerEmailsData } = require('./email-capture');
const { computeReceiptSettingsData, saveReceiptSettings, handleLogoUpload } = require('./theme-settings');
const { computeLoyaltyPageData, saveLoyaltyProgram, redeemForCustomer } = require('./loyalty');
const { computeBillingData, syncSubscriptionFromStripe } = require('./billing');
const { computePosSetupData, getGuideProviders, computeGuideData } = require('./oauth-square');
const { getCurrentAffiliate, buildAffiliateView } = require('./affiliates');
const { getBaseUrl, getSelfUrl } = require('../lib/baseUrl');
const QRCode = require('qrcode');
const { createTestReceiptToken } = require('../lib/testReceiptToken');
const {
  TAX_NUMBER_LABEL_GROUPS,
  CUSTOM_TAX_LABEL,
  isCustomTaxNumberLabel,
} = require('../lib/taxLabels');
const {
  createCheckoutSession,
  createPortalSession,
  createSetupIntent,
  attachPaymentMethod,
  setDefaultPaymentMethod,
  removePaymentMethod,
  resumeSubscription,
  listPaymentMethods,
} = require('../services/stripeService');

function requireAuth(req, res, next) {
  // Carry where they were headed through the login, so toggling Personal ->
  // Business lands on the Business page rather than the default hub. Mirrors
  // requireCustomerAuth in routes/customer-account.js.
  if (!req.session?.merchantId) {
    return res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

// Gates the six "premium" wallet sections (Receipts, Analytics, Customers,
// Customer emails, POS connection, Setup guide) on a REAL card on file,
// checked live against Stripe -- not just merchant.subscriptionStatus.
// That field can drift from reality (e.g. a merchant whose stripeCustomerId/
// stripeSubscriptionId were left over from a test-mode signup before this
// app switched to live keys: the DB still says TRIALING, but those IDs
// don't exist in live Stripe, so the merchant has no real subscription at
// all). middleware/demoAccountGate.js already blocks true demo accounts
// from these paths; this catches the same "not really unlocked yet" case
// for everyone else too. listPaymentMethods() (services/stripeService.js)
// already fails safe to an empty list on any Stripe error, so a merchant
// with dead/placeholder IDs correctly reads as "no card" here.
// Which section someone was trying to open, so the billing page can say so by
// name. Longest paths first -- /pos/guides has to match before /pos.
const LOCKED_SECTION_NAMES = [
  ['/account/business/receipts', 'Receipts'],
  ['/account/business/analytics', 'Analytics'],
  ['/account/business/customers', 'Customers'],
  ['/account/business/emails', 'Customer emails'],
  ['/account/business/pos', 'POS connection'],
];

function lockedSectionFor(url) {
  const path = (url || '').split('?')[0];
  const hit = LOCKED_SECTION_NAMES.find(([prefix]) => path.startsWith(prefix));
  return hit ? hit[1] : null;
}

async function requireFullBusinessAccess(req, res, next) {
  try {
    const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
    const { paymentMethods } = await listPaymentMethods(merchant);
    if (paymentMethods.length > 0) return next();

    // Used to redirect to Receipt design, which was a dead end: someone who
    // clicked "View all" under Recent receipts landed on an unrelated editor
    // with no explanation and reasonably concluded the link was broken.
    // Billing is where the thing they're missing actually gets fixed, and
    // ?locked= lets that page name the section they were reaching for.
    const section = lockedSectionFor(req.originalUrl);
    return res.redirect('/account/business/billing' + (section ? '?locked=' + encodeURIComponent(section) : ''));
  } catch (err) {
    // Fail-open, same posture as demoAccountGate/subscriptionGate/legalReacceptance.
    console.error('requireFullBusinessAccess check failed:', err);
    next();
  }
}

// The Dashboard tab (see partials/business-tab-bar.ejs) -- the section's
// landing page and default redirect target from login/signup.
router.get('/account/business', requireAuth, async (req, res) => {
  res.render('business-overview', await computeOverviewData(req.session.merchantId));
});

// The More tab -- the remaining sections that don't get their own place
// in the tab bar, same menu-row pattern as views/account-more.ejs.
router.get('/account/business/more', requireAuth, async (req, res) => {
  const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
  const { paymentMethods } = await listPaymentMethods(merchant);
  res.render('business-more', { merchant, hasFullAccess: paymentMethods.length > 0 });
});

router.get('/account/business/receipts', requireAuth, requireFullBusinessAccess, async (req, res) => {
  const data = await computeReceiptsHubData(req.session.merchantId, {
    from: req.query.from,
    to: req.query.to,
    tab: req.query.tab,
    page: req.query.page,
    pageSize: 5,
  });
  res.render('business-receipts', data);
});

// ---------------------------------------------------------------------------
// Claim a ReceipTap from its activation code alone.
//
// GET/POST /claim/:puckId (routes/pucks.js) is the other way in, and it only
// works if you physically tapped the puck -- that's where the ID in the URL
// comes from. This path takes the 6-character code on its own, which is what
// the Dashboard's setup guide has always told merchants they could do, and
// what the Get started card's "Already have a code?" link needs.
//
// Not behind requireFullBusinessAccess: claiming hardware is part of getting
// started, so a merchant still on trial has to be able to do it.
// ---------------------------------------------------------------------------
router.get('/account/business/claim', requireAuth, (req, res) => {
  res.render('business-claim', { error: req.query.error || null, submittedCode: '' });
});

router.post('/account/business/claim', requireAuth, async (req, res) => {
  const raw = typeof req.body.claimCode === 'string' ? req.body.claimCode.trim().toUpperCase() : '';
  const fail = (error, keepCode) =>
    res.status(400).render('business-claim', { error, submittedCode: keepCode ? raw : '' });

  // Keyed on the merchant, not the IP: the session is already required to
  // reach this route at all, so this is the account doing the guessing.
  const limitKey = req.session.merchantId;
  if (claimLimit.isLockedOut(limitKey)) {
    return fail('Too many incorrect codes. Wait 15 minutes and try again.', false);
  }

  if (!/^[A-Z0-9]{6}$/.test(raw)) {
    return fail('An activation code is 6 letters and numbers. Check the insert card that came with your ReceipTap.', true);
  }

  const puck = await prisma.puck.findUnique({ where: { claimCode: raw } });

  // A wrong code and an already-claimed one are both failures worth counting,
  // but they get different wording -- "someone already claimed this" is a real
  // situation a merchant needs to act on, not a typo to retry.
  if (!puck) {
    claimLimit.recordFailure(limitKey);
    return fail("We don't recognise that code. Check the insert card and try again.", true);
  }

  if (puck.status !== 'UNCLAIMED') {
    claimLimit.recordFailure(limitKey);
    if (puck.merchantId === req.session.merchantId) {
      return fail('That ReceipTap is already on your account.', false);
    }
    return fail('That ReceipTap has already been claimed by another account. Contact support@receiptap.com if you believe that is a mistake.', false);
  }

  await prisma.puck.update({
    where: { id: puck.id },
    data: { status: 'CLAIMED', merchantId: req.session.merchantId, claimedAt: new Date() },
  });
  claimLimit.clear(limitKey);

  // Straight to the POS page: a claimed ReceipTap still routes nothing until
  // it's linked to a register, so this is the next thing that has to happen.
  res.redirect('/account/business/pos?claimed=' + encodeURIComponent(puck.id));
});

router.get('/account/business/pucks', requireAuth, async (req, res) => {
  res.render('business-pucks', await computePucksData(req.session.merchantId, req.query));
});

// Same ownership check and effect as POST /dashboard/pucks/:id/unassign
// (routes/merchant-dashboard.js) -- just redirects back into the wallet
// instead of the real dashboard.
router.post('/account/business/pucks/:id/unassign', requireAuth, async (req, res) => {
  const puck = await prisma.puck.findUnique({ where: { id: req.params.id } });
  if (!puck || puck.merchantId !== req.session.merchantId) {
    return res.status(403).json({ error: 'Not your puck' });
  }
  await prisma.puck.update({ where: { id: puck.id }, data: { posLocationId: null, posDeviceId: null } });
  res.redirect(`/account/business/pucks?selected=${puck.id}`);
});

router.get('/account/business/analytics', requireAuth, requireFullBusinessAccess, async (req, res) => {
  res.render('business-analytics', await computeAnalyticsData(req.session.merchantId, req.query.days));
});

router.get('/account/business/customers', requireAuth, requireFullBusinessAccess, async (req, res) => {
  res.render('business-customers', await computeRepeatCustomersData(req.session.merchantId));
});

router.get('/account/business/emails', requireAuth, requireFullBusinessAccess, async (req, res) => {
  res.render('business-emails', await computeCustomerEmailsData(req.session.merchantId, req.query));
});

// Same action as POST /dashboard/customer-emails/delete (routes/email-capture.js)
// -- reuses the same deleteShopperByEmail() call, just redirects back into
// the wallet instead of the real dashboard.
router.post('/account/business/emails/delete', requireAuth, requireFullBusinessAccess, async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
  if (!email) return res.redirect('/account/business/emails');

  await deleteShopperByEmail(email, req.session.merchantId, { dryRun: false });
  res.redirect('/account/business/emails?deleted=1');
});

router.get('/account/business/receipt-design', requireAuth, async (req, res) => {
  res.render('business-receipt-design', await computeReceiptSettingsData(req.session.merchantId));
});

// Same handleLogoUpload/saveReceiptSettings as POST /dashboard/settings/receipt
// (routes/theme-settings.js) -- see the comments there for why the multer
// error path stashes onto req instead of rendering directly.
router.post('/account/business/receipt-design', requireAuth, handleLogoUpload, async (req, res) => {
  if (req.logoUploadError) {
    const data = await computeReceiptSettingsData(req.session.merchantId);
    return res.status(400).render('business-receipt-design', { ...data, error: req.logoUploadError });
  }
  const result = await saveReceiptSettings(req.session.merchantId, req.body, req.file);
  res.render('business-receipt-design', result);
});

// The stamp card, sitting directly under Receipt design in the More menu.
// Same no-requireFullBusinessAccess treatment as Receipt design: configuring
// a loyalty program isn't one of the gated business tools, and the program
// can't stamp anything until a customer saves a receipt anyway.
// Run a test sale: hands back a link + QR to a receipt rendered exactly as a
// customer would see it, using this merchant's saved design.
//
// No Transaction is created. The old demo-only test sale wrote a real row,
// which is precisely why it was restricted -- one test sale in a live
// merchant's data would show up in their revenue, receipt counts, analytics
// and exports. This is signed and read-only instead, so it's safe for any
// merchant, subscribed or not.
router.post('/account/business/receipt-design/test-sale', requireAuth, async (req, res) => {
  const layout = /^[a-z]+$/.test(req.body.layoutId || '') ? req.body.layoutId : 'classic';
  const token = createTestReceiptToken(req.session.merchantId);
  // getSelfUrl, not getBaseUrl: this link has to open from wherever the
  // dashboard is actually running. See lib/baseUrl.js.
  const receiptUrl = `${getSelfUrl(req)}/receipt/test/${token}?layout=${layout}`;

  try {
    const qrDataUrl = await QRCode.toDataURL(receiptUrl, { width: 480, margin: 1 });
    res.json({ receiptUrl, qrDataUrl });
  } catch (err) {
    // The link alone is still useful -- don't fail the whole thing over a QR.
    console.error('[test-sale] QR generation failed:', err.message);
    res.json({ receiptUrl, qrDataUrl: null });
  }
});

router.get('/account/business/loyalty', requireAuth, async (req, res) => {
  res.render('business-loyalty', await computeLoyaltyPageData(req.session.merchantId));
});

// Reuses theme-settings' multer handler -- the card logo is the same kind of
// upload as the receipt logo, into the same directory, under the same 2MB and
// image-type limits. Same error path too: multer stashes onto req rather than
// rendering, so this route renders its own template.
router.post('/account/business/loyalty', requireAuth, handleLogoUpload, async (req, res) => {
  if (req.logoUploadError) {
    const data = await computeLoyaltyPageData(req.session.merchantId);
    return res.status(400).render('business-loyalty', { ...data, error: req.logoUploadError });
  }
  res.render('business-loyalty', await saveLoyaltyProgram(req.session.merchantId, req.body, req.file));
});

// Staff redeeming a full card at the counter. Renders rather than redirects so
// the result lands beside the box it was typed into.
router.post('/account/business/loyalty/redeem', requireAuth, async (req, res) => {
  const result = await redeemForCustomer(req.session.merchantId, req.body.email, req.body.code);
  const data = await computeLoyaltyPageData(req.session.merchantId);
  res.render('business-loyalty', { ...data, redeemMessage: result.message || null, redeemError: result.error || null });
});

// The Partner Program card reached from the More tab. Same buildAffiliateView()
// data GET /dashboard/referrals shows (routes/affiliates.js) -- no
// requireFullBusinessAccess gate here, deliberately: referring other
// businesses doesn't require a paid ReceipTap subscription of your own (see
// the comment on buildAffiliateView), same as Receipt design. The view's
// forms/links pass redirectTo=/account/business/referrals (or ?next=... for
// the Stripe Connect hop) so every round trip lands back in the wallet.
router.get('/account/business/referrals', requireAuth, async (req, res) => {
  const affiliate = await getCurrentAffiliate(req);
  const view = await buildAffiliateView(affiliate);
  res.render('business-referrals', {
    ...view,
    referralUrl: `${getBaseUrl(req)}/signup?ref=${view.referralCode}`,
    connectError: req.query.connect_error === '1',
    codeError: req.query.code_error || null,
    codeSuccess: req.query.code_success === '1',
  });
});

// The POS connection card reached from the More tab. computePosSetupData is
// shared with GET /dashboard/pos-setup (routes/oauth-square.js) -- Connect
// links here pass ?next=/account/business/pos so all four OAuth callbacks
// (routes/oauth-{square,clover,lightspeed,shopify}.js) know to land back
// here afterward instead of the real dashboard; see lib/posReturnPath.js.
// Disconnect and puck-assignment actions reuse the exact same routes the
// real dashboard's pos-setup.ejs already posts to (disconnect-pos below
// with redirectTo=/account/business/pos, and the assign/assign-clover/
// assign-lightspeed/assign-shopify JSON endpoints in the oauth-*.js files,
// which were already provider-agnostic with no hardcoded redirect).
router.get('/account/business/pos', requireAuth, requireFullBusinessAccess, async (req, res) => {
  const data = await computePosSetupData(req.session.merchantId);
  res.render('business-pos-setup', { ...data, posError: req.query.posError || null });
});

// Dark reskins of the "How to connect & assign a puck" walkthroughs
// (views/pos-setup-guide.ejs / pos-setup-guides-index.ejs) -- same
// getGuideProviders()/computeGuideData() data (routes/oauth-square.js), so
// the step text and screenshots stay identical between both surfaces.
// Note: the screenshots themselves (POS_SETUP_GUIDES' image paths) are
// still captures of the real navy dashboard's UI -- retaking them against
// this dark theme is real follow-up work, not done here.
router.get('/account/business/pos/guides', requireAuth, requireFullBusinessAccess, (req, res) => {
  res.render('business-pos-setup-guides', { providers: getGuideProviders() });
});

router.get('/account/business/pos/guide/:provider', requireAuth, requireFullBusinessAccess, (req, res) => {
  const data = computeGuideData(req.params.provider);
  if (!data) return res.status(404).send('No setup guide for that POS provider.');
  res.render('business-pos-setup-guide', data);
});

router.get('/account/business/settings', requireAuth, async (req, res) => {
  const [merchant, receiptTheme] = await Promise.all([
    prisma.merchant.findUnique({ where: { id: req.session.merchantId } }),
    prisma.receiptTheme.findUnique({ where: { merchantId: req.session.merchantId } }),
  ]);
  const taxNumberLabel = (receiptTheme && receiptTheme.taxNumberLabel) || '';
  const taxNumber2Label = (receiptTheme && receiptTheme.taxNumber2Label) || '';
  res.render('business-settings', {
    merchant,
    receiptTheme,
    // Tax type is a dropdown rather than free text, same reasoning as the
    // Receipt design page's tax label: the common regimes spelled one way.
    // "Custom" stays for anything the list doesn't cover, and a label the
    // merchant already saved that isn't a preset opens the dropdown there
    // with their wording intact instead of silently becoming something else.
    taxNumberLabelGroups: TAX_NUMBER_LABEL_GROUPS,
    customTaxLabelValue: CUSTOM_TAX_LABEL,
    taxNumberLabelIsCustom: isCustomTaxNumberLabel(taxNumberLabel),
    taxNumber2LabelIsCustom: isCustomTaxNumberLabel(taxNumber2Label),
    businessError: req.query.businessError || null,
    businessSuccess: req.query.businessSuccess === '1',
    addressSuccess: req.query.addressSuccess === '1',
    disconnectAllSuccess: req.query.disconnectAllSuccess === '1',
    purgeDays: DEACTIVATED_MERCHANT_PURGE_DAYS,
  });
});

// Profile Settings: photo, owner name, owner phone, password, and log out --
// everything that's about the PERSON running the account rather than the
// business itself. Used to be folded into Business Settings (a redirect
// sat here for a while, when that was the only place these fields lived),
// but that meant "who am I" and "what's my business" were one long page.
// Split back out, listed above Business Settings on the More menu
// (views/business-more.ejs).
router.get('/account/business/account', requireAuth, async (req, res) => {
  const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
  res.render('business-account', {
    merchant,
    profileError: req.query.profileError || null,
    profileSuccess: req.query.profileSuccess === '1',
    passwordError: req.query.passwordError || null,
    passwordSuccess: req.query.passwordSuccess === '1',
  });
});

// Danger Zone's "Disconnect all tiles" -- fully releases every ReceipTap
// currently claimed to this account, not just unassigning it from a
// register (that's the lighter-weight per-puck action above). Safe to do
// in bulk: Transaction rows key off posLocationId/posDeviceId strings, not
// a real foreign key to Puck, so releasing a puck never touches historical
// receipts -- it just frees the physical device back to the unclaimed
// pool, exactly like a brand-new puck, so each one needs its claim code
// entered again before it can be used.
router.post('/account/business/pucks/disconnect-all', requireAuth, async (req, res) => {
  await prisma.puck.updateMany({
    where: { merchantId: req.session.merchantId },
    data: {
      merchantId: null,
      status: 'UNCLAIMED',
      posLocationId: null,
      posDeviceId: null,
      claimedAt: null,
      currentTransactionId: null,
      transactionExpiresAt: null,
      returnDeadlineAt: null,
      returnedAt: null,
    },
  });
  res.redirect('/account/business/settings?disconnectAllSuccess=1');
});

// The Billing card reached from the More tab. Same data GET /dashboard/billing
// shows (computeBillingData is shared, see routes/billing.js). Most
// merchants reach this page with a real subscription already in flight
// (requireActiveSubscription blocks anyone else, server.js) -- but a demo
// account skips that gate (middleware/demoAccountGate.js), so this is also
// the one wallet page that has to handle "no subscription yet" for real:
// business-billing.ejs shows a Start-trial panel instead of Manage billing
// in that case, backed by the checkout route below. Canceling/changing an
// existing plan still funnels through the "Manage billing" button into
// Stripe's own hosted Customer Portal -- only payment method management
// (add/set default/remove, below) is native here, since that was
// specifically asked for.
router.get('/account/business/billing', requireAuth, async (req, res) => {
  if (req.query.success === '1') {
    await syncSubscriptionFromStripe(req.session.merchantId);
  }

  const data = await computeBillingData(req.session.merchantId);
  res.render('business-billing', {
    ...data,
    error: req.query.error || null,
    pmSuccess: req.query.pmSuccess === '1',
    lockedSection: typeof req.query.locked === 'string' ? req.query.locked.slice(0, 40) : null,
    // Set by middleware/subscriptionGate.js when it redirects a merchant with
    // no live subscription here. Without it the bounce is silent: they tap
    // Receipts, land on Billing, and nothing says why.
    blocked: req.query.blocked === '1',
    justResumed: req.query.resumed === '1',
    justStarted: req.query.success === '1',
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
  });
});

// Same createCheckoutSession() call as POST /dashboard/billing/checkout
// (routes/billing.js) -- only the return URLs differ, so starting a trial
// from the wallet's Billing page (the demo account's "Start 30-day free
// trial" button, business-billing.ejs) lands back in the wallet instead of
// the real dashboard.
router.post('/account/business/billing/checkout', requireAuth, async (req, res) => {
  try {
    const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const url = await createCheckoutSession(
      merchant,
      `${baseUrl}/account/business/billing?success=1`,
      `${baseUrl}/account/business/billing?canceled=1`
    );
    res.redirect(url);
  } catch (err) {
    res.redirect(`/account/business/billing?error=${encodeURIComponent(err.message)}`);
  }
});

// Same resumeSubscription() call as POST /dashboard/billing/resume
// (routes/billing.js) -- undoes a pending end-of-period cancellation,
// redirecting back into the wallet instead of the real dashboard.
router.post('/account/business/billing/resume', requireAuth, async (req, res) => {
  try {
    const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
    if (!merchant.stripeSubscriptionId) throw new Error('No active subscription found.');
    await resumeSubscription(merchant.stripeSubscriptionId);
    res.redirect('/account/business/billing?resumed=1');
  } catch (err) {
    res.redirect(`/account/business/billing?error=${encodeURIComponent(err.message)}`);
  }
});

// Same createPortalSession() call as POST /dashboard/billing/portal
// (routes/billing.js) -- only the return URL differs, so a merchant who
// opened this from the wallet lands back in the wallet instead of the real
// dashboard once they're done in Stripe's UI.
router.post('/account/business/billing/portal', requireAuth, async (req, res) => {
  try {
    const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const url = await createPortalSession(merchant, `${baseUrl}/account/business/billing`);
    res.redirect(url);
  } catch (err) {
    res.redirect(`/account/business/billing?error=${encodeURIComponent(err.message)}`);
  }
});

// JSON endpoint the Payment Method panel's "Add payment method" form calls
// before it ever shows a card field -- the client secret this returns is
// what lets Stripe.js collect the actual card number in the browser
// (business-billing.ejs's Stripe Elements form), so our server never
// receives it.
router.post('/account/business/billing/setup-intent', requireAuth, async (req, res) => {
  try {
    const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
    const clientSecret = await createSetupIntent(merchant);
    res.json({ clientSecret });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Called by the same form once Stripe.js has confirmed the SetupIntent
// client-side -- at this point Stripe already has the card, this just
// attaches the resulting (tokenized, never-raw) payment method ID to the
// merchant's customer record.
router.post('/account/business/billing/payment-methods', requireAuth, async (req, res) => {
  try {
    const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
    await attachPaymentMethod(merchant, req.body.paymentMethodId);
    res.redirect('/account/business/billing?pmSuccess=1');
  } catch (err) {
    res.redirect(`/account/business/billing?error=${encodeURIComponent(err.message)}`);
  }
});

router.post('/account/business/billing/payment-methods/:id/default', requireAuth, async (req, res) => {
  try {
    const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
    await setDefaultPaymentMethod(merchant, req.params.id);
    res.redirect('/account/business/billing?pmSuccess=1');
  } catch (err) {
    res.redirect(`/account/business/billing?error=${encodeURIComponent(err.message)}`);
  }
});

// Blocked by removePaymentMethod() itself if this would leave zero cards
// on file -- see the comment there for why that's a real billing
// requirement, not just a UX guardrail.
router.post('/account/business/billing/payment-methods/:id/delete', requireAuth, async (req, res) => {
  try {
    const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
    await removePaymentMethod(merchant, req.params.id);
    res.redirect('/account/business/billing?pmSuccess=1');
  } catch (err) {
    res.redirect(`/account/business/billing?error=${encodeURIComponent(err.message)}`);
  }
});

module.exports = router;
