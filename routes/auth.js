// routes/auth.js
// Merchant account creation and session login — the missing piece every
// other route (requireAuth checking req.session.merchantId) depends on.

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const prisma = require('../lib/prisma');
const { sendPasswordResetEmail, sendVerificationEmail } = require('../services/emailService');
const { recordLegalAcceptances } = require('../services/legalAcceptanceService');
const { safeNextPath } = require('../lib/safeRedirect');
const { normalizeEmail } = require('../lib/normalizeEmail');
const { resolveReferrer } = require('../lib/referralAttribution');
const { getBaseUrl } = require('../lib/baseUrl');
const { buildState, parseState } = require('../lib/oauthState');
const appleAuthService = require('../services/appleAuthService');
const microsoftAuthService = require('../services/microsoftAuthService');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

router.get('/signup', (req, res) => res.render('signup', {
  error: null,
  refCode: req.query.ref || '',
  next: req.query.next || '',
  demo: req.query.demo === '1',
  prefillEmail: req.query.email || '',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  appleClientId: process.env.APPLE_CLIENT_ID || '',
  microsoftClientId: process.env.MICROSOFT_CLIENT_ID || '',
}));
router.get('/login', (req, res) => res.render('login', {
  error: null,
  deactivated: req.query.deactivated === '1',
  // Default post-login destination is the wallet's dark Business section
  // now, not the real navy-sidebar dashboard -- see routes/account-business.js.
  // An explicit ?redirect= (e.g. a deep link back to a specific /dashboard/*
  // page) is still honored as-is.
  redirect: req.query.redirect || '/account/business',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  appleClientId: process.env.APPLE_CLIENT_ID || '',
  microsoftClientId: process.env.MICROSOFT_CLIENT_ID || '',
}));

router.post('/signup', async (req, res) => {
  const { ownerName, businessName, email: rawEmail, password, confirmPassword, refCode, next, demo, acceptAll } = req.body;
  const email = normalizeEmail(rawEmail);
  const demoFields = {
    refCode: refCode || '',
    next: next || '',
    demo: demo || '',
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    appleClientId: process.env.APPLE_CLIENT_ID || '',
    microsoftClientId: process.env.MICROSOFT_CLIENT_ID || '',
  };

  if (!ownerName || !businessName || !email || !password) {
    return res.render('signup', { error: 'All fields are required', ...demoFields });
  }
  // Client-side "required"/matching on the two password fields is UX
  // only -- same as the checkbox below, this is the real gate.
  if (password !== confirmPassword) {
    return res.render('signup', { error: 'Passwords do not match.', ...demoFields });
  }
  // Client-side "required" on the checkbox is UX only -- this is the real
  // gate. A request without it never creates an account. One checkbox now
  // covers all three documents (Terms + the DPA it incorporates by
  // reference, plus having read the Privacy Policy) -- see
  // recordLegalAcceptances() below for why that still means three
  // LegalAcceptance rows, not one.
  if (!acceptAll) {
    return res.render('signup', { error: "You must agree to the Terms of Service (which include the Data Processing Agreement), and confirm you've read the Privacy Policy, to create an account.", ...demoFields });
  }

  try {
    const existing = await prisma.merchant.findUnique({ where: { email } });
    if (existing) {
      return res.render('signup', { error: 'An account with this email already exists', ...demoFields });
    }

    // Referral is best-effort -- an invalid/expired code shouldn't block signup,
    // it just means this merchant signs up without an attributed affiliate.
    // Explicit ?ref beats the 90-day attribution cookie, which beats a wallet
    // account on this email that a merchant's receipt introduced. See
    // lib/referralAttribution.js.
    const referrer = await resolveReferrer({ prisma, refCode, req, email });

    const isDemoAccount = Boolean(demo);
    const passwordHash = await bcrypt.hash(password, 10);

    // Only demo accounts need to prove their email is real -- see
    // config/legal.js-adjacent reasoning in services/emailService.js. Paid
    // signups skip this entirely; Stripe checkout already does that job.
    const emailVerificationToken = isDemoAccount ? crypto.randomBytes(32).toString('hex') : null;
    const emailVerificationTokenExpiresAt = isDemoAccount ? new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS) : null;

    const merchant = await prisma.merchant.create({
      data: { ownerName, businessName, email, passwordHash, referredByAffiliateId: referrer?.id || null, isDemoAccount, emailVerificationToken, emailVerificationTokenExpiresAt },
    });
    await recordLegalAcceptances(merchant.id, req);

    if (isDemoAccount) {
      const verifyUrl = `${req.protocol}://${req.get('host')}/verify-email/${emailVerificationToken}`;
      await sendVerificationEmail({ email: merchant.email, name: merchant.ownerName || merchant.businessName }, verifyUrl);
    }

    req.session.merchantId = merchant.id;
    // Demo accounts always land on receipt design -- it's the only page
    // they're allowed on (see middleware/demoAccountGate.js) -- rather than
    // trusting `next`, which now defaults to the wallet's Business section
    // instead of the real dashboard (same default as GET/POST /login).
    res.redirect(isDemoAccount ? '/dashboard/settings/receipt' : safeNextPath(next, '/account/business'));
  } catch (err) {
    console.error('Signup failed:', err);
    res.render('signup', { error: 'Something went wrong on our end — please try again in a moment.', ...demoFields });
  }
});

router.post('/login', async (req, res) => {
  const { email: rawEmail, password } = req.body;
  const email = normalizeEmail(rawEmail);
  // Same default as GET /login above -- only reached if the form's own
  // hidden redirect field is somehow missing. Passed through the shared
  // allowlist: this value round-trips via ?redirect= and a hidden field, so
  // without it a crafted link could bounce a merchant off-site immediately
  // after they'd typed their password.
  const redirect = safeNextPath(req.body.redirect, '/account/business');
  const oauthFields = {
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    appleClientId: process.env.APPLE_CLIENT_ID || '',
    microsoftClientId: process.env.MICROSOFT_CLIENT_ID || '',
  };

  try {
    const merchant = await prisma.merchant.findUnique({ where: { email } });
    if (!merchant || !merchant.passwordHash || !(await bcrypt.compare(password, merchant.passwordHash))) {
      return res.render('login', { error: 'Invalid email or password', redirect, ...oauthFields });
    }
    if (!merchant.isActive) {
      return res.render('login', { error: 'This account has been deactivated.', redirect, ...oauthFields });
    }

    req.session.merchantId = merchant.id;
    res.redirect(redirect);
  } catch (err) {
    console.error('Login failed:', err);
    res.render('login', { error: 'Something went wrong on our end — please try again in a moment.', redirect, ...oauthFields });
  }
});

// Clears only the merchant session. session.destroy() would take the whole
// session with it, including customerId -- and the same browser can legitimately
// be signed in as both a merchant and a shopper (CLAUDE.md: never clear one when
// logging out the other). Mirrors POST /account/logout, which already does this
// correctly for the customer side.
router.post('/logout', (req, res) => {
  delete req.session.merchantId;
  res.redirect('/login');
});

// --- Sign in with Google (doubles as signup — one step for both) ------------
// Used by both the login page and the signup page: if the Google account's
// email doesn't have a Merchant record yet, one is created automatically.
// Business/owner name aren't knowable from Google alone, so a new account
// gets an editable placeholder business name -- same tradeoff already made
// for the equivalent customer-facing flow in routes/customer-account.js.
router.post('/merchant/google', async (req, res) => {
  const { credential, refCode, next, demo, acceptAll } = req.body;
  if (!credential) return res.status(400).json({ error: 'Missing Google credential' });

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    return res.status(401).json({ error: 'Could not verify Google sign-in' });
  }

  if (!payload.email) return res.status(400).json({ error: 'Google account has no email' });
  const email = normalizeEmail(payload.email);

  try {
    let merchant = await prisma.merchant.findUnique({ where: { email } });

    if (merchant) {
      if (!merchant.isActive) return res.status(403).json({ error: 'This account has been deactivated.' });
      if (!merchant.googleId) {
        merchant = await prisma.merchant.update({ where: { id: merchant.id }, data: { googleId: payload.sub } });
      }
    } else {
      // New account -- same consent requirement as the plain signup form
      // (views/signup.ejs checks this client-side too, but that can always
      // be bypassed, so it's enforced here independently).
      if (!acceptAll) {
        return res.status(400).json({ error: "Please agree to the Terms of Service (which include the Data Processing Agreement), and confirm you've read the Privacy Policy, first." });
      }

      const referrer = await resolveReferrer({ prisma, refCode, req, email });

      // Google already verified this email before handing it to us -- a demo
      // account created this way skips the token/link flow entirely and is
      // considered verified from the start (payload.email_verified is
      // effectively always true for a completed Google sign-in).
      merchant = await prisma.merchant.create({
        data: {
          email,
          googleId: payload.sub,
          ownerName: payload.name || null,
          businessName: payload.given_name ? `${payload.given_name}'s Business` : 'My Business',
          referredByAffiliateId: referrer?.id || null,
          isDemoAccount: Boolean(demo),
          emailVerifiedAt: payload.email_verified ? new Date() : null,
        },
      });
      await recordLegalAcceptances(merchant.id, req);
    }

    req.session.merchantId = merchant.id;
    // Same reasoning as the plain signup form -- a demo account always lands
    // on receipt design, the only page it's allowed on. Uses the merchant's
    // actual isDemoAccount (not just this request's `demo` flag), so an
    // existing demo merchant logging back in still lands correctly even if
    // `demo` wasn't part of this particular request.
    res.json({ success: true, redirect: merchant.isDemoAccount ? '/dashboard/settings/receipt' : safeNextPath(next, '/account/business') });
  } catch (err) {
    console.error('Google sign-in failed:', err);
    res.status(500).json({ error: 'Something went wrong on our end — please try again in a moment.' });
  }
});

// Shared by the Apple and Microsoft merchant callbacks below -- same
// find-or-create shape as the Google handler above (existing merchant ->
// backfill the provider id; no merchant -> gate on acceptAll, same as the
// plain signup form), just parametrized by provider so it isn't written
// out twice. Google's handler above is left as its own inline block
// rather than refactored onto this, since it already works and isn't part
// of this change.
async function findOrCreateMerchantFromOAuth({ providerIdField, sub, email: rawEmail, name, refCode, demo, acceptAll, req }) {
  const email = normalizeEmail(rawEmail);
  let merchant = await prisma.merchant.findUnique({ where: { email } });

  if (merchant) {
    if (!merchant.isActive) throw Object.assign(new Error('This account has been deactivated.'), { status: 403 });
    if (!merchant[providerIdField]) {
      merchant = await prisma.merchant.update({ where: { id: merchant.id }, data: { [providerIdField]: sub } });
    }
    return merchant;
  }

  if (!acceptAll) {
    throw Object.assign(
      new Error("Please agree to the Terms of Service (which include the Data Processing Agreement), and confirm you've read the Privacy Policy, first."),
      { status: 400 }
    );
  }

  const referrer = await resolveReferrer({ prisma, refCode, req, email });

  merchant = await prisma.merchant.create({
    data: {
      email,
      [providerIdField]: sub,
      ownerName: name || null,
      businessName: name ? `${name.split(' ')[0]}'s Business` : 'My Business',
      referredByAffiliateId: referrer?.id || null,
      isDemoAccount: Boolean(demo),
      // Apple and Microsoft both only hand us a verified email in the
      // first place -- same reasoning as the Google handler skipping the
      // token/link verification flow.
      emailVerifiedAt: new Date(),
    },
  });
  await recordLegalAcceptances(merchant.id, req);
  return merchant;
}

// Renders back whichever page (login or signup) the merchant actually
// started from, reconstructed from `state` -- an OAuth callback has no
// natural "go back" the way a same-page form submission does, so state is
// what carries that context across the round trip to Apple/Microsoft.
function renderOAuthError(req, res, parsedState, error) {
  const status = error.status || 500;
  if (error.status === undefined) console.error('OAuth merchant sign-in failed:', error);
  const common = {
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    appleClientId: process.env.APPLE_CLIENT_ID || '',
    microsoftClientId: process.env.MICROSOFT_CLIENT_ID || '',
  };
  const message = error.status ? error.message : 'Something went wrong on our end — please try again in a moment.';

  if (parsedState?.from === 'signup') {
    return res.status(status).render('signup', {
      error: message,
      refCode: parsedState.refCode || '',
      next: parsedState.next || '',
      demo: Boolean(parsedState.demo),
      ...common,
    });
  }
  return res.status(status).render('login', {
    error: message,
    deactivated: false,
    redirect: parsedState?.next || '/account/business',
    ...common,
  });
}

router.get('/merchant/apple/connect', (req, res) => {
  const { nonce, state } = buildState({
    from: req.query.from === 'signup' ? 'signup' : 'login',
    next: req.query.next || '',
    refCode: req.query.refCode || '',
    demo: req.query.demo === '1',
    acceptAll: req.query.acceptAll === '1',
  });
  req.session.appleOauthNonce = nonce;
  const redirectUri = `${getBaseUrl(req)}/merchant/apple/callback`;
  res.redirect(appleAuthService.buildAuthorizeUrl(redirectUri, state));
});

// Apple POSTs here (response_mode=form_post), not a GET like Microsoft/most
// OAuth providers -- express.urlencoded is already mounted app-wide in
// server.js, which is what makes req.body.code/state readable below.
router.post('/merchant/apple/callback', async (req, res) => {
  const parsedState = parseState(req.body.state);
  const nonceOk = parsedState && parsedState.nonce === req.session.appleOauthNonce;
  delete req.session.appleOauthNonce;

  if (!req.body.code || !nonceOk) {
    return renderOAuthError(req, res, parsedState, Object.assign(new Error('Could not verify Apple sign-in.'), { status: 400 }));
  }

  try {
    const redirectUri = `${getBaseUrl(req)}/merchant/apple/callback`;
    const tokens = await appleAuthService.exchangeCodeForToken(req.body.code, redirectUri);
    const identity = await appleAuthService.verifyIdToken(tokens.id_token);
    if (!identity.email) throw Object.assign(new Error('Apple account has no email'), { status: 400 });

    // Apple only ever sends the user's name once, as a JSON blob in
    // `req.body.user`, on the very first authorization -- never available
    // on repeat sign-ins, so this is best-effort only.
    let name = null;
    try {
      name = req.body.user ? JSON.parse(req.body.user).name?.firstName : null;
    } catch {
      // malformed/missing -- fine, ownerName just stays unset
    }

    const merchant = await findOrCreateMerchantFromOAuth({
      providerIdField: 'appleId',
      sub: identity.sub,
      email: normalizeEmail(identity.email),
      name,
      refCode: parsedState.refCode,
      demo: parsedState.demo,
      acceptAll: parsedState.acceptAll,
      req,
    });

    req.session.merchantId = merchant.id;
    res.redirect(merchant.isDemoAccount ? '/dashboard/settings/receipt' : safeNextPath(parsedState.next, '/account/business'));
  } catch (err) {
    renderOAuthError(req, res, parsedState, err);
  }
});

router.get('/merchant/microsoft/connect', (req, res) => {
  const { nonce, state } = buildState({
    from: req.query.from === 'signup' ? 'signup' : 'login',
    next: req.query.next || '',
    refCode: req.query.refCode || '',
    demo: req.query.demo === '1',
    acceptAll: req.query.acceptAll === '1',
  });
  req.session.microsoftOauthNonce = nonce;
  const redirectUri = `${getBaseUrl(req)}/merchant/microsoft/callback`;
  res.redirect(microsoftAuthService.buildAuthorizeUrl(redirectUri, state));
});

router.get('/merchant/microsoft/callback', async (req, res) => {
  const parsedState = parseState(req.query.state);
  const nonceOk = parsedState && parsedState.nonce === req.session.microsoftOauthNonce;
  delete req.session.microsoftOauthNonce;

  if (!req.query.code || !nonceOk) {
    return renderOAuthError(req, res, parsedState, Object.assign(new Error('Could not verify Microsoft sign-in.'), { status: 400 }));
  }

  try {
    const redirectUri = `${getBaseUrl(req)}/merchant/microsoft/callback`;
    const tokens = await microsoftAuthService.exchangeCodeForToken(req.query.code, redirectUri);
    const identity = await microsoftAuthService.verifyIdToken(tokens.id_token);
    if (!identity.email) throw Object.assign(new Error('Microsoft account has no email'), { status: 400 });

    const merchant = await findOrCreateMerchantFromOAuth({
      providerIdField: 'microsoftId',
      sub: identity.sub,
      email: normalizeEmail(identity.email),
      name: null, // Microsoft's id_token doesn't reliably include a given name in this scope set
      refCode: parsedState.refCode,
      demo: parsedState.demo,
      acceptAll: parsedState.acceptAll,
      req,
    });

    req.session.merchantId = merchant.id;
    res.redirect(merchant.isDemoAccount ? '/dashboard/settings/receipt' : safeNextPath(parsedState.next, '/account/business'));
  } catch (err) {
    renderOAuthError(req, res, parsedState, err);
  }
});

router.get('/forgot-password', (req, res) => res.render('forgot-password', { error: null, sent: false }));

router.post('/forgot-password', async (req, res) => {
  const email = normalizeEmail(req.body.email);

  try {
    const merchant = email ? await prisma.merchant.findUnique({ where: { email } }) : null;

    // Always render the same success state whether or not the email has an
    // account -- otherwise this becomes a way to check who's a merchant.
    if (merchant) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      await prisma.merchant.update({
        where: { id: merchant.id },
        data: { resetToken, resetTokenExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
      });

      const resetUrl = `${req.protocol}://${req.get('host')}/reset-password/${resetToken}`;
      await sendPasswordResetEmail({ email: merchant.email, name: merchant.ownerName || merchant.businessName }, resetUrl);
    }

    res.render('forgot-password', { error: null, sent: true });
  } catch (err) {
    console.error('Forgot-password request failed:', err);
    res.render('forgot-password', { error: 'Something went wrong on our end — please try again in a moment.', sent: false });
  }
});

router.get('/reset-password/:token', async (req, res) => {
  const merchant = await prisma.merchant.findUnique({ where: { resetToken: req.params.token } });
  const valid = Boolean(merchant && merchant.resetTokenExpiresAt > new Date());
  res.render('reset-password', { token: req.params.token, valid, error: null });
});

router.post('/reset-password/:token', async (req, res) => {
  const { password, confirmPassword } = req.body;
  const merchant = await prisma.merchant.findUnique({ where: { resetToken: req.params.token } });
  const valid = Boolean(merchant && merchant.resetTokenExpiresAt > new Date());

  if (!valid) {
    return res.render('reset-password', { token: req.params.token, valid: false, error: null });
  }
  if (!password || password.length < 8) {
    return res.render('reset-password', { token: req.params.token, valid: true, error: 'Password must be at least 8 characters.' });
  }
  if (password !== confirmPassword) {
    return res.render('reset-password', { token: req.params.token, valid: true, error: 'Passwords do not match.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.merchant.update({
    where: { id: merchant.id },
    data: { passwordHash, resetToken: null, resetTokenExpiresAt: null },
  });

  req.session.merchantId = merchant.id;
  res.redirect('/account/business');
});

// Demo-tier email verification (see the isDemoAccount branch in POST
// /signup above). Token is single-use and expires 24 hours after issue.
router.get('/verify-email/:token', async (req, res) => {
  const merchant = await prisma.merchant.findUnique({ where: { emailVerificationToken: req.params.token } });
  const valid = Boolean(merchant && merchant.emailVerificationTokenExpiresAt > new Date());

  if (valid) {
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { emailVerifiedAt: new Date(), emailVerificationToken: null, emailVerificationTokenExpiresAt: null },
    });
  }

  res.render('verify-email', { valid });
});

// Lets a signed-in demo merchant get a fresh link if theirs expired --
// linked from the "verify your email" banner on theme-settings.
router.post('/verify-email/resend', async (req, res) => {
  if (!req.session?.merchantId) return res.redirect('/login');

  const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
  if (!merchant || !merchant.isDemoAccount || merchant.emailVerifiedAt) {
    return res.redirect('/dashboard/settings/receipt');
  }

  const emailVerificationToken = crypto.randomBytes(32).toString('hex');
  await prisma.merchant.update({
    where: { id: merchant.id },
    data: { emailVerificationToken, emailVerificationTokenExpiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS) },
  });

  const verifyUrl = `${req.protocol}://${req.get('host')}/verify-email/${emailVerificationToken}`;
  await sendVerificationEmail({ email: merchant.email, name: merchant.ownerName || merchant.businessName }, verifyUrl);

  res.redirect('/dashboard/settings/receipt?resent=1');
});

module.exports = router;
