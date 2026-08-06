// middleware/demoAccountGate.js
// A demo-tier merchant (Merchant.isDemoAccount) signed up free, with no
// card, specifically to design their receipt before committing to a paid
// plan -- they never have a real Stripe subscription. Restricts them to
// exactly two things: receipt design (what they're here for) and billing
// (their path to actually upgrade). Everything else on /dashboard redirects
// to receipt design.
//
// Mounted before subscriptionGate in server.js. requireActiveSubscription
// (middleware/subscriptionGate.js) separately skips its own check for demo
// accounts -- without that, it would immediately redirect a demo account
// away from receipt design too, since their subscriptionStatus is
// permanently INCOMPLETE. The two gates are deliberately aware of each
// other rather than fighting over the same request.
const prisma = require('../lib/prisma');

const ALLOWED_PATH_PREFIXES = ['/settings/receipt', '/billing'];

async function requireDemoAccess(req, res, next) {
  try {
    const merchant = await prisma.merchant.findUnique({
      where: { id: req.session.merchantId },
      select: { isDemoAccount: true },
    });
    if (!merchant?.isDemoAccount) return next(); // not a demo account -- nothing to do here

    if (ALLOWED_PATH_PREFIXES.some((prefix) => req.path.startsWith(prefix))) return next();

    return res.redirect('/dashboard/settings/receipt');
  } catch (err) {
    // Same fail-open posture as subscriptionGate/legalReacceptance -- a
    // broken check should never lock a merchant out of their own dashboard.
    console.error('Demo account gate failed:', err);
    next();
  }
}

module.exports = { requireDemoAccess };
