// middleware/requireAdmin.js
// Owner-only access for /admin.
//
// Who counts as an owner is decided by the ADMIN_EMAILS environment variable —
// deliberately NOT a database column. A flag in the database could in principle
// be flipped by anything that can write to the database; an env var can only be
// changed by someone with access to the server itself. There is no way to grant
// yourself admin through the app.
//
// Non-admins get a 404, not a 403: a 403 would confirm that /admin exists.

const prisma = require('../lib/prisma');

function adminEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

async function requireAdmin(req, res, next) {
  const allowed = adminEmails();

  // No admins configured = admin area is switched off entirely.
  if (allowed.length === 0) return res.status(404).send('Not found');
  if (!req.session?.merchantId) return res.status(404).send('Not found');

  try {
    const merchant = await prisma.merchant.findUnique({
      where: { id: req.session.merchantId },
      select: { email: true, businessName: true },
    });
    if (!merchant || !allowed.includes(merchant.email.toLowerCase())) {
      return res.status(404).send('Not found');
    }
    res.locals.adminUser = merchant;
    next();
  } catch (err) {
    next(err);
  }
}

/** Safe for any page to call — true only if the logged-in user is an owner. */
async function isAdmin(req) {
  const allowed = adminEmails();
  if (allowed.length === 0 || !req.session?.merchantId) return false;
  try {
    const m = await prisma.merchant.findUnique({
      where: { id: req.session.merchantId },
      select: { email: true },
    });
    return Boolean(m && allowed.includes(m.email.toLowerCase()));
  } catch {
    return false;
  }
}

module.exports = { requireAdmin, isAdmin };
