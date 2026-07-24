// middleware/ownerFlag.js
// Makes `isOwner` available to every rendered page, so the sidebar and topbar
// can show the Owner view link to you and to nobody else.
//
// MOUNT THIS EARLY — before the dashboard routes. If it runs after them, the
// dashboard has already rendered and the flag arrives too late to matter.
//
// The result is cached on the session, so this costs one small lookup per
// login rather than one per page view. If you change ADMIN_EMAILS, log out
// and back in to pick up the change.

const { isAdmin } = require('./requireAdmin');

async function ownerFlag(req, res, next) {
  try {
    if (!process.env.ADMIN_EMAILS || !req.session?.merchantId) {
      res.locals.isOwner = false;
      return next();
    }

    if (typeof req.session.isOwner === 'boolean') {
      res.locals.isOwner = req.session.isOwner;
      return next();
    }

    const owner = await isAdmin(req);
    req.session.isOwner = owner;
    res.locals.isOwner = owner;
    next();
  } catch (err) {
    // Never let this break a page — worst case the link just doesn't show.
    res.locals.isOwner = false;
    next();
  }
}

module.exports = { ownerFlag };
