// services/appleAuthService.js
// "Sign in with Apple" — a redirect-based OAuth flow, not a JS SDK widget
// like Google's, so it follows the same shape as the POS provider services
// (build authorize URL -> callback exchanges a code -> verify identity).
//
// Apple's OAuth token endpoint authenticates the client with a JWT
// ("client secret") that WE generate and sign ourselves using a private
// key downloaded from the Apple Developer portal -- there is no static
// client-secret string the way Clover/Lightspeed/Shopify have. That JWT is
// short-lived (Apple allows up to 6 months) and gets regenerated on demand
// rather than cached, since generating it is cheap and this avoids any
// expiry-tracking logic.

const { SignJWT, importPKCS8, createRemoteJWKSet, jwtVerify } = require('jose');

const APPLE_AUTHORIZE_URL = 'https://appleid.apple.com/auth/authorize';
const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

// The .p8 private key is stored in .env as a single line with literal
// newlines escaped to \n (the only way a multi-line PEM fits in one env
// var) -- restore real newlines before handing it to jose.
function getPrivateKey() {
  return (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
}

function buildAuthorizeUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: process.env.APPLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    response_mode: 'form_post', // required by Apple whenever requesting the "name"/"email" scopes
    scope: 'name email',
    state,
  });
  return `${APPLE_AUTHORIZE_URL}?${params}`;
}

// Apple's own "client secret" -- a JWT we sign, not a value Apple gives us.
async function generateClientSecret() {
  const key = await importPKCS8(getPrivateKey(), 'ES256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: process.env.APPLE_KEY_ID })
    .setIssuer(process.env.APPLE_TEAM_ID)
    .setIssuedAt(now)
    .setExpirationTime(now + 15777000) // ~6 months, Apple's maximum
    .setAudience(APPLE_ISSUER)
    .setSubject(process.env.APPLE_CLIENT_ID)
    .sign(key);
}

async function exchangeCodeForToken(code, redirectUri) {
  const clientSecret = await generateClientSecret();
  const res = await fetch(APPLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.APPLE_CLIENT_ID,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`Apple token exchange failed: ${res.status}`);
  return res.json(); // { access_token, id_token, ... }
}

// Verifies Apple's id_token against Apple's own public keys and returns
// the identity it actually vouches for -- never trust a decoded-but-
// unverified token for who the merchant/customer claims to be.
async function verifyIdToken(idToken) {
  const { payload } = await jwtVerify(idToken, APPLE_JWKS, {
    issuer: APPLE_ISSUER,
    audience: process.env.APPLE_CLIENT_ID,
  });
  return { sub: payload.sub, email: payload.email };
}

module.exports = { buildAuthorizeUrl, exchangeCodeForToken, verifyIdToken };
