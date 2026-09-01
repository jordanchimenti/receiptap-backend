// middleware/demoAccountGate.js
// A demo-tier merchant (Merchant.isDemoAccount) signed up free, with no
// card, specifically to design their receipt before committing to a paid
// plan -- they never have a real Stripe subscription. Restricts them to
// receipt design (what they're here for), billing (their path to actually
// upgrade), account/business settings, and the Partner Program (which is
// free -- joining and earning from it never require a paid subscription, so
// a demo account accrues commission on its referrals like anyone else).
// Everything else redirects to receipt design
// -- real usage data (Receipts, Analytics, Customers, Customer emails, POS
// connection) requires an actual subscription and a POS actually wired up.
//
// Mounted before subscriptionGate on BOTH /dashboard (the real navy-rail
// dashboard) and /account/business (the wallet's dark reskin, server.js) --
// ALLOWED_PATH_PREFIXES below are full absolute paths covering both
// surfaces, matched against req.originalUrl rather than req.path, since
// req.path is relative to whichever mount point fired and would otherwise
// silently fail to match the /account/business half of this list.
// requireActiveSubscription (middleware/subscriptionGate.js) separately
// skips its own check for demo accounts -- without that, it would
// immediately redirect a demo account away from receipt design too, since
// their subscriptionStatus is permanently INCOMPLETE. The two gates are
// deliberately aware of each other rather than fighting over the same
// request.
const prisma = require('../lib/prisma');

const ALLOWED_PATH_PREFIXES = [
  // Real dashboard (navy rail)
  '/dashboard/settings/receipt',
  '/dashboard/billing',
  '/dashboard/referrals',
  // Shared save routes business-settings.ejs/business-account.ejs (wallet)
  // post to directly -- also the old dashboard's own Settings page at this
  // same path.
  '/dashboard/settings/account',
  // Wallet's "Business" section
  '/account/business/more',
  '/account/business/settings',
  '/account/business/account',
  '/account/business/billing',
  '/account/business/receipt-design',
  '/account/business/referrals',
  // Business Settings' "Disconnect all ReceipTaps" danger-zone action --
  // deliberately more specific than '/account/business/pucks' so the
  // ReceipTaps tab and its per-puck unassign action stay locked.
  '/account/business/pucks/disconnect-all',
];

async function requireDemoAccess(req, res, next) {
  try {
    // Mounted immediately before subscriptionGate on both /dashboard and
    // /account/business (server.js), which used to run its OWN
    // prisma.merchant.findUnique for the same merchant right after this one
    // -- two full round trips to Postgres, back to back, for identical
    // data, on every single dashboard/wallet page a merchant loads. Fetching
    // the full row here (not just isDemoAccount) and stashing it on the
    // request lets subscriptionGate reuse it instead of asking again.
    const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
    req._merchant = merchant;
    if (!merchant?.isDemoAccount) return next(); // not a demo account -- nothing to do here

    const pathname = req.originalUrl.split('?')[0];
    if (ALLOWED_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return next();

    // Bounce back into whichever surface the request came from, rather than
    // always kicking a blocked wallet request out to the real dashboard.
    const fallback = pathname.startsWith('/account/business')
      ? '/account/business/receipt-design'
      : '/dashboard/settings/receipt';
    return res.redirect(fallback);
  } catch (err) {
    // Same fail-open posture as subscriptionGate/legalReacceptance -- a
    // broken check should never lock a merchant out of their own dashboard.
    console.error('Demo account gate failed:', err);
    next();
  }
}

module.exports = { requireDemoAccess };
