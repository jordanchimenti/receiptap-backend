// lib/referralAttribution.js
// Credits the merchant who introduced someone to ReceipTap.
//
// The path this exists for: a shopper taps a puck at Merchant A's counter,
// saves the receipt to their wallet, and months later signs their OWN business
// up for ReceipTap. Merchant A did the introducing, so Merchant A earns the
// commission -- even though the shopper never clicked a /signup?ref= link.
//
// Attribution is remembered two ways, because either can be the one that
// survives:
//   1. A 90-day cookie -- works even if they sign up with a different email
//      than the one on their wallet account.
//   2. Customer.referredByAffiliateId -- works even on a different device or
//      after clearing cookies, as long as they use the same email.
//
// FIRST TOUCH WINS on both. Neither is overwritten once set, so the merchant
// who actually made the introduction keeps the credit rather than whichever
// counter the shopper happened to visit most recently.
//
// An explicit ?ref= code always beats both: someone who deliberately followed
// a partner's link is that partner's referral, full stop.
const REFERRAL_WINDOW_DAYS = 90;
const REFERRAL_COOKIE = 'rt_ref';
const WINDOW_MS = REFERRAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// Parsed by hand rather than adding cookie-parser: this is the only cookie the
// app reads, and express-session handles its own.
function readReferralCookie(req) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === REFERRAL_COOKIE) {
      try { return decodeURIComponent(rest.join('=')) || null; } catch { return null; }
    }
  }
  return null;
}

/** First touch wins -- never overwrite an existing attribution. */
function setReferralCookie(req, res, code) {
  if (!code || readReferralCookie(req)) return false;
  res.cookie(REFERRAL_COOKIE, code, {
    maxAge: WINDOW_MS,
    httpOnly: true,          // nothing client-side needs to read it
    sameSite: 'lax',         // survives the normal top-level navigation to /signup
    secure: process.env.NODE_ENV === 'production',
  });
  return true;
}

function isWithinWindow(attributedAt, now = Date.now()) {
  if (!attributedAt) return false;
  return now - new Date(attributedAt).getTime() <= WINDOW_MS;
}

/**
 * Which affiliate (if any) should be credited for a merchant signing up.
 * Explicit code > cookie > the wallet account on this email, in that order.
 * Returns null when nothing applies -- callers treat referral as best-effort
 * and never block a signup on it.
 */
async function resolveReferrer({ prisma, refCode, req, email }) {
  const byCode = async (code) => (code
    ? prisma.affiliate.findUnique({ where: { referralCode: String(code).trim().toUpperCase() } })
    : null);

  const explicit = await byCode(refCode);
  if (explicit) return explicit;

  const cookied = await byCode(readReferralCookie(req));
  if (cookied) return cookied;

  if (email) {
    const customer = await prisma.customer.findUnique({ where: { email: String(email).trim().toLowerCase() } });
    if (customer?.referredByAffiliateId && isWithinWindow(customer.referralAttributedAt)) {
      return prisma.affiliate.findUnique({ where: { id: customer.referredByAffiliateId } });
    }
  }
  return null;
}

/** Records that this merchant introduced this shopper. No-op if already set. */
async function attributeCustomerToMerchant({ prisma, customerId, affiliate, req, res }) {
  if (!affiliate) return;
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (customer && !customer.referredByAffiliateId) {
    await prisma.customer.update({
      where: { id: customerId },
      data: { referredByAffiliateId: affiliate.id, referralAttributedAt: new Date() },
    });
  }
  setReferralCookie(req, res, affiliate.referralCode);
}

module.exports = {
  REFERRAL_WINDOW_DAYS,
  REFERRAL_COOKIE,
  readReferralCookie,
  setReferralCookie,
  isWithinWindow,
  resolveReferrer,
  attributeCustomerToMerchant,
};
