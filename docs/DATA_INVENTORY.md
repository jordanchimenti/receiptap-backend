# ReceipTap Data Inventory

Built by reading `prisma/schema.prisma` and the actual route/service code that
reads and writes each field — not inferred from field names or comments.
Where a code path could not be found or confirmed, the row says `UNKNOWN`
rather than guessing. This document contains no legal analysis or legal
language; it is a factual trace of what the code does.

**Method note on "Does it leave Canada?"** — the Postgres database
(Supabase) is confirmed hosted in AWS `ca-central-1` (Montreal) from the
`DATABASE_URL` host in `.env`
(`aws-0-ca-central-1.pooler.supabase.com`). The application server itself is
hosted on Railway, which has **no Canadian region** — the four options are
US West, US East, EU West (Amsterdam) and Southeast Asia (Singapore).
**US East (Virginia) is the chosen region** (founder decision, 2026-08-18);
it is a dashboard setting, not visible in this repo, since `railway.json`
has no field for it. Rows marked `NO*` therefore mean "no known transmission
to a foreign subprocessor was found in the code — but every request still
transits the US-based app server." Rows marked
`YES` are transmissions to a specific named subprocessor confirmed by reading
the actual API call.

---

## 1. Personal Data Inventory

### Merchant

| Field | Whose data | Purpose | Third parties | Retention / deletion | Leaves Canada? |
|---|---|---|---|---|---|
| `Merchant.businessName` | MERCHANT | Shown as the seller name on every receipt; sent to Stripe as the billing customer's display name (`stripeService.js` `createCheckoutSession` → `stripe.customers.create({ name: merchant.businessName })`); sent to Anthropic as `merchantName` in the AI-categorization prompt (`categorize-receipt.js`, via `transaction.merchant.businessName` in `routes/email-capture.js` and `routes/customer-account.js`) | Stripe, Anthropic | NOTHING DELETES IT | YES (Stripe, Anthropic) |
| `Merchant.ownerName` | MERCHANT | Dashboard greeting ("Welcome back, X"); used as the display name in password-reset emails (`routes/auth.js`: `sendPasswordResetEmail({ name: merchant.ownerName \|\| merchant.businessName })`) | Resend | NOTHING DELETES IT | YES (Resend) |
| `Merchant.profilePhotoUrl` | MERCHANT | Avatar shown in the dashboard rail; file itself saved to local disk via multer (`routes/billing.js`, `public/uploads/profile-photos/`) | None (file lives on the app server's own disk, not a third-party storage provider) | NOTHING DELETES IT — old photo file is not removed from disk when replaced, and the row is never cleared | NO* |
| `Merchant.email` | MERCHANT | Login identifier; sent to Stripe as billing customer email; used as the `to` address for password-reset emails via Resend; used by `requireAdmin` to check against `ADMIN_EMAILS` | Stripe, Resend | NOTHING DELETES IT | YES (Stripe, Resend) |
| `Merchant.passwordHash` | MERCHANT | bcrypt hash, used to verify login (`routes/auth.js`) | None | NOTHING DELETES IT | NO* |
| `Merchant.googleId` | MERCHANT | Recognizes a returning merchant who signed in with Google (`routes/auth.js` `/merchant/google`) | None after collection — this value is Google's own identifier for the account (`payload.sub`), extracted from a token Google already issued; it is not sent onward anywhere | NOTHING DELETES IT | NO* |
| `Merchant.resetToken` / `resetTokenExpiresAt` | MERCHANT | Single-use password-reset link, embedded in the URL sent via Resend | Resend (the token value is embedded in the reset URL emailed out) | Cleared to `null` on successful reset (`routes/auth.js` line ~206). **If a reset is requested but never completed, the token is never cleared** — it just becomes unusable after the 1-hour expiry check; the value itself remains in the row indefinitely | YES (transits Resend as part of the URL) |
| `Merchant.squareMerchantId` | MERCHANT | Identifies which Square account a webhook event belongs to (`routes/webhooks.js`) | Square (implicitly — it's Square's own identifier for the merchant, returned during OAuth) | NOTHING DELETES IT | YES (Square) |
| `Merchant.squareAccessToken` | MERCHANT | Bearer token sent to Square's API to fetch order details (`services/squareService.js` `fetchOrder`) | Square | NOTHING DELETES IT | YES (Square) |
| `Merchant.shopifyShopDomain` | MERCHANT | Identifies which Shopify shop a webhook event belongs to (`routes/webhooks.js`, matched against the `X-Shopify-Shop-Domain` header); also the API host itself, since Shopify has no shared API domain (`services/shopifyService.js` `shopifyAdminBaseUrl`) | Shopify (it's the merchant's own `*.myshopify.com` domain, supplied at connect time) | NOTHING DELETES IT | YES (Shopify) |
| `Merchant.shopifyAccessToken` | MERCHANT | Bearer token sent to the Shopify Admin API to fetch order details and register webhooks (`services/shopifyService.js`); populated by `routes/oauth-shopify.js` | Shopify | NOTHING DELETES IT | YES (Shopify) |
| `Merchant.cloverMerchantId` | MERCHANT | Identifies which Clover merchant a webhook event belongs to (`routes/webhooks.js`) | Clover | NOTHING DELETES IT | YES (Clover) |
| `Merchant.cloverAccessToken` / `cloverRefreshToken` / `cloverAccessTokenExpiresAt` | MERCHANT | Bearer token + refresh credential sent to Clover's API to fetch order details (`services/cloverService.js`) | Clover | NOTHING DELETES IT | YES (Clover) |
| `Merchant.lightspeedDomainPrefix` | MERCHANT | Identifies which Lightspeed X-Series retailer a webhook event belongs to (`routes/webhooks.js`); also forms the API host, `https://{domainPrefix}.retail.lightspeed.app` (`services/lightspeedService.js`) | Lightspeed (it's Lightspeed's own retailer prefix, returned during OAuth) | NOTHING DELETES IT | YES (Lightspeed) |
| `Merchant.lightspeedAccessToken` / `lightspeedRefreshToken` / `lightspeedAccessTokenExpiresAt` | MERCHANT | Bearer token + refresh credential sent to Lightspeed's API to fetch sale details and register webhooks (`services/lightspeedService.js`); populated by `routes/oauth-lightspeed.js` | Lightspeed | NOTHING DELETES IT | YES (Lightspeed) |
| `Merchant.stripeCustomerId` | MERCHANT | Stripe's own identifier for this merchant's billing account, used on every subsequent billing call (`services/stripeService.js`, `routes/billing.js`) | Stripe (it's Stripe's own ID, round-tripped on every call) | NOTHING DELETES IT | YES (Stripe) |
| `Merchant.stripeSubscriptionId` | MERCHANT | Stripe's own identifier for the merchant's subscription, used to check/change subscription state | Stripe | NOTHING DELETES IT | YES (Stripe) |
| `Merchant.subscriptionStatus` / `trialEndsAt` | MERCHANT | Gates dashboard access (`middleware/subscriptionGate.js`) | None (mirrors what Stripe reports, but not itself sent anywhere) | NOTHING DELETES IT | NO* |
| `Merchant.createdAt` | MERCHANT | Account age, shown in admin exports | None | NOTHING DELETES IT | NO* |
| `Merchant.referredByAffiliateId` | MERCHANT | Links a merchant to the affiliate who referred them, for commission attribution | None | NOTHING DELETES IT | NO* |

### Puck

`Puck` holds no data about an identifiable *person* — `posLocationId` /
`posDeviceId` are the POS's own identifiers for a register/terminal (business
equipment), not a personal device. Included per the task's instruction to
treat device identifiers as in-scope rather than silently excluding them.

| Field | Whose data | Purpose | Third parties | Retention / deletion | Leaves Canada? |
|---|---|---|---|---|---|
| `Puck.posLocationId` / `posDeviceId` | MERCHANT (business equipment, not a person) | Routes an incoming webhook sale to the correct puck so a tap shows the right receipt (`routes/webhooks.js`) | None (received from Square/Clover webhooks, not sent onward) | NOTHING DELETES IT | NO* |

### Transaction

| Field | Whose data | Purpose | Third parties | Retention / deletion | Leaves Canada? |
|---|---|---|---|---|---|
| `Transaction.lineItems` (JSON: name, quantity, unitPrice, total per item) | SHOPPER | Renders the itemized receipt; **item `name` + `quantity` only** (not price/total) are sent to Anthropic for AI categorization — see the dedicated Anthropic section below for the exact payload | Anthropic (name + quantity only, per item — see below) | NOTHING DELETES IT | YES (to Anthropic, partial fields only) |
| `Transaction.subtotal` / `tax` / `discountTotal` / `total` | SHOPPER | Shown on the receipt; feeds merchant-facing revenue analytics (`routes/analytics.js`) and CSV exports | None — confirmed NOT included in the Anthropic prompt | NOTHING DELETES IT | NO* |
| `Transaction.paymentMethod` (e.g. "Visa ••••4242 — Paid") | SHOPPER | Card brand + last 4 digits only (not a full PAN), received from the Square/Clover webhook payload and displayed on the receipt | None (received from Square/Clover, not retransmitted) | NOTHING DELETES IT | NO* (received from Square/Clover, which is itself a Canada-leaving event on the *inbound* side — see Subprocessors) |
| `Transaction.customerId` | SHOPPER | Links a transaction to the shopper's wallet account, once claimed | None | NOTHING DELETES IT | NO* |
| `Transaction.aiCategory` / `aiTaxDeductible` / `aiReasoning` | SHOPPER (a label derived from their purchase) | Shown to the shopper in their wallet; feeds the merchant's repeat-customer category breakdown (`routes/repeat-customers.js`) | None onward — this is Anthropic's *response*, written back to the DB, not sent anywhere further | NOTHING DELETES IT | NO* (the data that produced it went to Anthropic; the label itself does not go anywhere further) |
| `Transaction.aiCategorizedAt` | SHOPPER | Used as a guard so a transaction is never categorized twice | None | NOTHING DELETES IT | NO* |
| `Transaction.collectedByMerchantId` | MERCHANT | A different merchant claiming this receipt as their own business expense | None | NOTHING DELETES IT | NO* |
| `Transaction.createdAt` | SHOPPER | The actual sale time as reported by the POS (used as the receipt date, and for repeat-customer visit recency / lapsed-customer segmentation) | None (originates from Square/Clover, not sent onward) | NOTHING DELETES IT | NO* |
| `Transaction.orderNumber`, `posLocationId`, `posDeviceId`, `posProvider` | MERCHANT (business/operational) | Displayed on the receipt (Order #); disambiguates which register rang up a multi-lane store | None | NOTHING DELETES IT | NO* |

### ReceiptTheme

| Field | Whose data | Purpose | Third parties | Retention / deletion | Leaves Canada? |
|---|---|---|---|---|---|
| `ReceiptTheme.logoUrl` | MERCHANT | Merchant's uploaded logo image, saved to local disk via multer (`routes/theme-settings.js`, `public/uploads/logos/`), shown on receipts | None (local disk) | NOTHING DELETES IT — old logo file is not removed from disk when replaced | NO* |
| `ReceiptTheme.location` / `phone` | MERCHANT | Free-text business address/phone line shown on receipts | None | NOTHING DELETES IT | NO* |
| `ReceiptTheme.gstHstNumber` | MERCHANT | Shown on receipts so a Canadian customer can claim an input tax credit | None | NOTHING DELETES IT | NO* |
| `ReceiptTheme.googleReviewUrl` | MERCHANT | A merchant-supplied link shown as a "Rate us on Google" card. **No Google Places/Reviews API call exists anywhere in the codebase** — this is a static URL the merchant pastes in, not an API integration | None — confirmed no `googleapis`/Places call in the repo | NOTHING DELETES IT | NO* |
| `ReceiptTheme.instagramUrl` / `facebookUrl` / `tiktokUrl` / `xUrl` / `youtubeUrl` / `linkedinUrl` | MERCHANT | Merchant's own social links, shown as icons on receipts | None (just rendered as `<a href>` tags) | NOTHING DELETES IT | NO* |

### LoyaltyProgram / LoyaltyCard

| Field | Whose data | Purpose | Third parties | Retention / deletion | Leaves Canada? |
|---|---|---|---|---|---|
| `LoyaltyCard.customerId` | SHOPPER | Links a punch card to a specific shopper at a specific merchant | None | NOTHING DELETES IT | NO* |
| `LoyaltyCard.punches`, `lastRedeemedAt`, `createdAt`, `updatedAt` | SHOPPER | Tracks loyalty progress/redemption history | None | NOTHING DELETES IT | NO* |

### Affiliate

`Affiliate` doesn't cleanly fit the task's MERCHANT/SHOPPER taxonomy for its
`REGULAR` type (a standalone referral partner, not a merchant and not a
shopper). Flagged rather than force-fit — see GAPS.

| Field | Whose data | Purpose | Third parties | Retention / deletion | Leaves Canada? |
|---|---|---|---|---|---|
| `Affiliate.name` / `email` | MERCHANT (if `type=MERCHANT`, since it's the merchant's own referral account) or **neither category** (if `type=REGULAR` — a standalone referral partner unrelated to any merchant or shopper) | Referral-program identity; `email` sent to Stripe when creating the affiliate's Connect payout account (`stripeService.js` `createAffiliateConnectAccount`) | Stripe | NOTHING DELETES IT | YES (Stripe) |
| `Affiliate.passwordHash` | Same as above | Login for `REGULAR`-type affiliates | None | NOTHING DELETES IT | NO* |
| `Affiliate.stripeConnectAccountId` | Same as above | Stripe Connect Express account that receives commission payouts. Per the code comment in `stripeService.js`, the affiliate's actual bank/ID details are entered directly on Stripe's own hosted onboarding page and **never touch this app's servers** | Stripe | NOTHING DELETES IT | YES (Stripe) |

### Commission

| Field | Whose data | Purpose | Third parties | Retention / deletion | Leaves Canada? |
|---|---|---|---|---|---|
| `Commission.stripeInvoiceId` / `stripeTransferId` | Tied to an Affiliate (see above) | Idempotency key for one commission per paid invoice; Stripe's own transfer identifier | Stripe (these ARE Stripe's own IDs, generated by Stripe, stored back) | NOTHING DELETES IT | YES (Stripe) |

### Customer

| Field | Whose data | Purpose | Third parties | Retention / deletion | Leaves Canada? |
|---|---|---|---|---|---|
| `Customer.email` | SHOPPER | Wallet login identity; the mechanism by which a merchant "collects an email" — every transaction linked to this email is visible to that merchant in `/dashboard/customer-emails` and exportable as CSV; also visible platform-wide to the ReceipTap owner via `/admin/customers` | Resend (password reset), Stripe is NOT sent shopper emails (confirmed — Stripe only ever receives Merchant/Affiliate emails, never Customer emails) | NOTHING DELETES IT — **no account-deletion route exists anywhere for Customer** (only `/account/logout`, which just clears the session) | YES (Resend, for password reset only) |
| `Customer.passwordHash` | SHOPPER | Wallet login verification | None | NOTHING DELETES IT | NO* |
| `Customer.googleId` | SHOPPER | Recognizes a returning shopper who signed in with Google | None after collection (see `Merchant.googleId` note — same pattern) | NOTHING DELETES IT | NO* |
| `Customer.name` | SHOPPER | Only ever populated via Google Sign-In (`payload.name`) — the plain email/password signup form (`routes/customer-account.js` `/account/signup`) never asks for or stores a name. Shown in the merchant's customer-emails list/export and the platform-wide admin export | None | NOTHING DELETES IT | NO* |
| `Customer.resetToken` / `resetTokenExpiresAt` | SHOPPER | Same single-use reset-link mechanism as Merchant (see above); cleared on success (`routes/customer-account.js` line ~171), not cleared if abandoned | Resend | YES (transits Resend as part of the URL) |

---

## 2. The Anthropic payload — exact fields, read from `services/categorize-receipt.js`

**Yes**, receipt line items are sent to the Anthropic API, but only two
specific pieces of information per line item — read directly from the
request-body construction, not assumed:

```js
// services/categorize-receipt.js, function categorizeTransaction()
const itemsSummary = lineItems.map((i) => `${i.quantity}x ${i.name}`).join(', ');

// ...sent as the user message content:
`Classify this purchase for personal/business expense tracking.

Merchant: ${merchantName}
Items: ${itemsSummary}
...`
```

**Exactly what's in the request:**
- `merchantName` — the seller's `Merchant.businessName` (passed in by both callers as `transaction.merchant.businessName`)
- `itemsSummary` — each line item reduced to `"{quantity}x {name}"`, comma-joined (e.g. `"1x Iced Coffee, 1x Blueberry Muffin"`)

**Confirmed NOT in the request:** `unitPrice`, item `total`, `Transaction.subtotal`/`tax`/`total`, `Transaction.id`, `Transaction.createdAt`, `paymentMethod`, the shopper's name or email, or the merchant's address/phone. The full `lineItems` array (with prices) is passed as a parameter into `categorizeTransaction()`, but only `quantity` and `name` are ever read out of it before the request is built — the rest of the object is simply unused by this function.

Model called: `claude-sonnet-4-6` (as literally written in the code — not verified against Anthropic's current model catalog, reported as-is).

Both call sites (`routes/customer-account.js`, `routes/email-capture.js`) fire this in the background (`.then()`/`.catch()`, not awaited) after a shopper claims a receipt (via email capture or wallet save), gated by `if (!transaction.aiCategorizedAt)` so it only runs once per transaction.

---

## 3. Subprocessors

Found by reading `package.json` dependencies and grepping every route/service
for outbound calls (`fetch(`, SDK client instantiations) — not from a
prior assumption list.

| Subprocessor | Data received | Fields (from Section 1) | Hosted in | DPA / privacy terms URL |
|---|---|---|---|---|
| **Supabase** (Postgres database) | Everything in the schema — this is the primary datastore | All fields | Canada (AWS `ca-central-1`, confirmed from `DATABASE_URL`) | Not present anywhere in repo config. Not fabricated here — verify directly at supabase.com. |
| **Railway** (app hosting) | The app process itself, and by extension every field in transit through it (request bodies, session cookies, DB query results before they render) | All fields, in transit | **United States — US East, Virginia** (`us-east4-eqdc4a`), chosen 2026-08-18. Railway has no Canadian region. Set in the Railway dashboard, not in this repo. | Not present in repo config. Verify directly at railway.app. |
| **Stripe** | Merchant billing identity (email, business name), Affiliate identity (email) and their Connect account, invoice/transfer IDs | `Merchant.email`, `Merchant.businessName`, `Merchant.stripeCustomerId`, `Merchant.stripeSubscriptionId`, `Affiliate.email`, `Affiliate.stripeConnectAccountId`, `Commission.stripeInvoiceId`/`stripeTransferId` | US (Stripe's standard API; no Canada-specific hosting configured in this repo) | Not present in repo config. Verify directly at stripe.com. |
| **Anthropic** | Merchant business name + item name/quantity per line item (see Section 2 for the exact payload) | `Merchant.businessName`, partial `Transaction.lineItems` (name + quantity only) | US (Anthropic's standard API; no region configured in this repo) | Not present in repo config. Verify directly at anthropic.com. |
| **Google** (Sign-In only — see note) | An ID token is sent to Google's verification library (`google-auth-library`) for both merchant and customer "Sign in with Google"; the email/name/sub already inside that Google-issued token is what gets extracted, not sent | `Merchant.email`/`googleId`, `Customer.email`/`googleId`/`name` (as the *source*, not an onward destination) | US/global (Google's identity infrastructure) | Not present in repo config. Verify directly at google.com. **Note:** "Google Reviews" is NOT a subprocessor here — confirmed no Places/Reviews API call exists; `ReceiptTheme.googleReviewUrl` is a plain merchant-supplied link. |
| **Square** | OAuth access token sent as a Bearer credential to fetch order data | `Merchant.squareAccessToken`, `Merchant.squareMerchantId` (sent); receives shopper purchase data *from* Square in the fetched order (line items, totals — this is inbound, not something ReceipTap sends Square) | US (Square's standard API; sandbox/production both `squareup.com`) | Not present in repo config. Verify directly at squareup.com. |
| **Clover** | OAuth access/refresh tokens sent as Bearer credentials to fetch order data | `Merchant.cloverAccessToken`, `Merchant.cloverRefreshToken`, `Merchant.cloverMerchantId` (sent); receives shopper purchase data *from* Clover in the fetched order (inbound) | US (`clover.com`/`apisandbox.dev.clover.com`) | Not present in repo config. Verify directly at clover.com. |
| **Resend** (email) | Recipient email + display name, embedded in password-reset emails (subject, HTML body, reset URL containing the token) | `Merchant.email`/`ownerName`/`resetToken`, `Customer.email`/`name`/`resetToken` | US (`resend.dev`/`resend.com`; the code comment notes the *sending* domain is currently the shared `resend.dev` sandbox, not a verified custom domain) | Not present in repo config. Verify directly at resend.com. |
| **Shopify** | OAuth access token sent as a Bearer credential to fetch order data and register webhooks | `Merchant.shopifyAccessToken`, `Merchant.shopifyShopDomain` (sent); receives shopper purchase data *from* Shopify in the fetched order (inbound). Also receives Shopify's three mandatory compliance webhooks (`routes/webhooks.js` `/webhooks/pos/shopify/compliance`) | **UNKNOWN** — calls go to the merchant's own `*.myshopify.com` domain, which does not reveal a region. Verify directly at shopify.com. | Not present in repo config. Verify directly at shopify.com. |
| **Lightspeed** (Retail / X-Series) | OAuth access/refresh tokens sent as Bearer credentials to fetch sale data and register webhooks | `Merchant.lightspeedAccessToken`, `Merchant.lightspeedRefreshToken`, `Merchant.lightspeedDomainPrefix` (sent); receives shopper purchase data *from* Lightspeed in the fetched sale (inbound) | **UNKNOWN** — `secure.retail.lightspeed.app` and `{domainPrefix}.retail.lightspeed.app`; neither reveals a region. Verify directly at lightspeedhq.com. | Not present in repo config. Verify directly at lightspeedhq.com. |

**Checked and confirmed absent:** no error-tracking tool (Sentry, Bugsnag,
Rollbar), no product analytics (Segment, Mixpanel, Amplitude, PostHog,
Google Analytics), no CDN/asset-storage provider (S3, Cloudinary) — logos
and profile photos are saved to the app server's own local disk via multer,
not a cloud storage subprocessor. No SMS provider. Confirmed by reading
`package.json`'s full dependency list and grepping for common SDK import
patterns.

---

## 4. Gaps

1. **NOTHING DELETES ANYTHING.** Grepped the entire codebase for
   `.delete(` / `.deleteMany(` against the Prisma client — zero results. The
   only thing resembling account closure is
   `routes/account-settings.js` `/dashboard/settings/account/deactivate`,
   which sets `Merchant.isActive = false` and cancels the Stripe
   subscription — it does not remove or anonymize any personal data. There
   is no equivalent deactivation *or* deletion route for `Customer` at all
   (only `/account/logout`, which clears a session cookie). Every personal
   data field in Section 1 is retained indefinitely once written.

2. **`Merchant.shopifyShopDomain` / `shopifyAccessToken` are dead fields —
   RESOLVED, the integration shipped.** These were scaffolding with no
   code path when this inventory was first written. They are now populated
   by `routes/oauth-shopify.js` and sent to the Shopify Admin API by
   `services/shopifyService.js`, and `routes/webhooks.js` handles both
   Shopify sale events and Shopify's three mandatory compliance webhooks.
   A **Lightspeed Retail (X-Series)** integration shipped alongside it
   (`routes/oauth-lightspeed.js`, `services/lightspeedService.js`). Both
   are now traced in Sections 1 and 3 above, and both are disclosed as
   subprocessors on the Privacy Policy and DPA as of `PRIVACY.version`
   `2026-08-18.1` / `DPA.version` `2026-08-18.1`. What's still open is the
   **hosting region** for every POS provider — Square and Clover were
   traced to US API hosts, but Shopify's and Lightspeed's hosts don't
   reveal one; see `docs/LEGAL_REVIEW_NOTES.md` item 7b.

3. **Abandoned password-reset tokens are never cleared.** `resetToken` /
   `resetTokenExpiresAt` (both `Merchant` and `Customer`) are only nulled
   out on a *successful* reset. If someone requests a reset and never
   completes it, the token string sits in that row indefinitely — unusable
   after 1 hour by the expiry check in the code, but not deleted.

4. **Old uploaded files are never cleaned up.** `ReceiptTheme.logoUrl` and
   `Merchant.profilePhotoUrl` point at files on local disk
   (`public/uploads/logos/`, `public/uploads/profile-photos/`). When a
   merchant uploads a replacement, the database row's URL is updated but the
   previous file is not deleted from disk — confirmed by reading the multer
   upload handlers in `routes/theme-settings.js` and `routes/billing.js`,
   neither of which contains any `fs.unlink` or equivalent.

5. **The app server is in the United States — RESOLVED and disclosed.**
   The Supabase database is confirmed in Canada (Montreal), but every
   request also passes through the app server, and Railway has no Canadian
   region. US East (Virginia) was chosen on 2026-08-18. So the "Does it
   leave Canada?" answers marked `NO*` throughout Section 1 mean "not sent
   to a foreign *subprocessor*" — they never meant "stayed in Canada," and
   under a US app server they definitely don't. Both the Privacy Policy and
   the DPA now state this outright, including that data processed there can
   be subject to US legal process (`PRIVACY.version`/`DPA.version`
   `2026-08-18.2`). One lawyer question remains open per document — see
   `docs/LEGAL_REVIEW_NOTES.md` item 5.

6. **Session data lives in Postgres — RESOLVED, but it is not a Prisma
   table.** This previously read "session data lives in server memory":
   `express-session` had no store configured and fell back to the built-in
   `MemoryStore`. It now uses `connect-pg-simple` (`lib/sessionStore.js`),
   writing to a `session` table in the same database. Contents are
   unchanged and still minimal — `merchantId`/`customerId`/`affiliateId`/
   `isOwner`, confirmed by grep, no other fields found in session — but they
   now persist across restarts instead of being discarded, which is what
   stops every merchant and shopper being logged out on every deploy.

   Two things to keep in mind for this document's purposes: the `session`
   table is **not** in `prisma/schema.prisma` (connect-pg-simple owns its
   layout), so it will never appear in Section 1 alongside the Prisma
   models; and session rows now sit in the database subject to the same
   retention questions as everything else, pruned every 15 minutes by
   expiry only. No retention window in `config/retention.js` governs them.

7. **Platform-wide shopper visibility.** `/admin/customers` and
   `/admin/customers/export` (gated by `requireAdmin`, i.e. `ADMIN_EMAILS`)
   expose every `Customer` record — email, name, which merchants, receipt
   count — across the *entire* platform, not scoped to one merchant. This
   isn't a third-party transmission, but it's a real internal-access surface
   worth naming: the platform owner can see every shopper's email and shopping
   pattern across every merchant, not just their own.

8. **IP addresses ARE collected — this section previously said otherwise
   and was wrong.** Corrected after re-verifying directly against current
   code rather than trusting the earlier claim below it. `req.ip` is read
   and stored in two places: `services/legalAcceptanceService.js` line 13
   (`const ipAddress = req.ip || null;`, written onto every
   `LegalAcceptance` row — a merchant accepting Terms/Privacy/DPA) and
   `services/shopperConsentService.js` line 21 (same pattern, written onto
   every `ShopperConsent` row — a shopper's transactional/marketing consent
   at the tap screen). Both are append-only audit records of a specific
   consent event, not a general tracking log — no other route reads
   `req.ip`, `x-forwarded-for`, or a user-agent string anywhere in
   `routes/`, `middleware/`, or `services/`. `app.set('trust proxy', 1)` in
   `server.js` is unrelated (it's for correctly reading HTTPS/secure-cookie
   state behind Railway's proxy). Since `LEGAL_ACCEPTANCE_RETENTION_MONTHS`
   and `EMAIL_SUPPRESSION_RETENTION_MONTHS` are both `Infinity`
   (`config/retention.js`), these IP addresses are retained indefinitely
   along with the rest of the consent record. This should be disclosed in
   the Privacy Policy's "what we collect" section — see
   `docs/LEGAL_REVIEW_NOTES.md`.

9. **`Affiliate` (type `REGULAR`) doesn't fit the MERCHANT/SHOPPER
   taxonomy** this task asked for — see the note in Section 1. Flagged
   rather than silently classified as one or the other.

10. **DPA/privacy-terms URLs: none found in repo config**, for any
    subprocessor. The task asked to note this rather than fabricate a URL
    and present it as sourced from the repo — every row in Section 3 says so
    explicitly.
