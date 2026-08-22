// services/microsoftAuthService.js
// "Sign in with Microsoft" -- same redirect-based OAuth shape as
// appleAuthService.js, but a standard authorization-code flow: a plain
// client secret (MICROSOFT_CLIENT_SECRET) rather than a JWT we generate,
// and a normal GET callback with ?code= rather than Apple's form_post.
//
// Using the "common" tenant so both personal Microsoft accounts and
// work/school (Azure AD) accounts can sign in -- the natural choice for a
// consumer-facing SaaS rather than restricting to one organization.

const { createRemoteJWKSet, jwtVerify } = require('jose');

const MS_AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const MS_JWKS = createRemoteJWKSet(new URL('https://login.microsoftonline.com/common/discovery/v2.0/keys'));

function buildAuthorizeUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: 'openid email profile',
    state,
  });
  return `${MS_AUTHORIZE_URL}?${params}`;
}

async function exchangeCodeForToken(code, redirectUri) {
  const res = await fetch(MS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      scope: 'openid email profile',
    }),
  });
  if (!res.ok) throw new Error(`Microsoft token exchange failed: ${res.status}`);
  return res.json(); // { access_token, id_token, ... }
}

// Verifies Microsoft's id_token against Microsoft's own public keys.
// The "common" endpoint's issuer includes the specific tenant GUID the
// user authenticated against, so it's checked as a prefix match rather
// than an exact string -- jose's `issuer` option only supports exact
// matches, so this is verified by hand after signature/audience checks.
async function verifyIdToken(idToken) {
  const { payload } = await jwtVerify(idToken, MS_JWKS, {
    audience: process.env.MICROSOFT_CLIENT_ID,
  });
  if (typeof payload.iss !== 'string' || !payload.iss.startsWith('https://login.microsoftonline.com/')) {
    throw new Error('Unexpected issuer in Microsoft id_token');
  }
  // preferred_username is the fallback for work/school accounts that
  // don't always populate `email` on the id_token.
  return { sub: payload.sub, email: payload.email || payload.preferred_username };
}

module.exports = { buildAuthorizeUrl, exchangeCodeForToken, verifyIdToken };
