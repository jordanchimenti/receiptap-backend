# ReceipTap

B2B SaaS + NFC hardware. A passive NFC puck sits beside a merchant's register.
Customers tap their phone after paying and get a digital receipt instantly — no
app, no account required. The merchant gets email capture, a Google review
funnel, and repeat-customer analytics. Customers get a cross-merchant wallet
with AI-categorized receipts.

Solo founder, first-time coder. Explain in plain language, one step at a time.

## Stack

- Node.js + Express, EJS server-rendered templates (no separate frontend)
- Prisma ORM + PostgreSQL hosted on Supabase
- Stripe for ReceipTap's own subscription billing
- Anthropic API for receipt categorization
- Playwright + archiver for bulk PDF export (archiver pinned to v6 — v8 has a
  breaking API change)

## Layout

- `server.js` — mounts everything. Order matters, see Gotchas.
- `routes/` — auth, legal, pucks, receipt, webhooks, oauth-square,
  merchant-dashboard, merchant-expenses, repeat-customers, analytics,
  pdf-export, theme-settings, email-capture, customer-account, billing, admin
- `middleware/` — subscriptionGate, requireAdmin, ownerFlag, legalReacceptance
- `services/` — categorize-receipt, generate-receipt-pdf, stripeService,
  legalAcceptanceService, shopperConsentService, dataRetentionService,
  emailSuppressionService
- `config/legal.js` — single source of truth for legal-document and
  consent-string versions. See Conventions.
- `config/retention.js` — single source of truth for every data-retention
  window. See Conventions.
- `views/` — EJS pages; `views/partials/dashboard-header.ejs` is the merchant
  sidebar included by every dashboard page
- `public/css/receiptap.css` — the whole design system, one file

## Conventions

- Money is stored in **cents** as integers. Divide by 100 only at render time.
- Auth is `req.session.merchantId` for merchants, `req.session.customerId` for
  customers. Both can be set in the same browser — never clear one when
  logging out the other.
- Merchant pages: `requireAuth` first, then the route.
- Design system: marketing pages use warm paper (`--paper`), the merchant
  dashboard uses a cool workspace surface (`--app-bg`) with a navy rail.
  Brand blue is `#056BFE`, sampled from the logo.
- Never invent data for the UI. If a number can't be computed from real rows,
  don't display it.
- `config/legal.js` is the only place legal-document and consent-string
  versions live. Any change to the wording of a legal document (once
  written) or the tap-screen consent strings (`SHOPPER_CONSENT` in that
  file) **requires bumping that item's version string in the same commit**.
  `LegalAcceptance`/`ShopperConsent` rows record whatever version was live
  at the moment someone agreed — silently editing wording without bumping
  the version breaks the ability to prove what a specific row's text
  actually said.
- The Data Processing Agreement is incorporated **by reference** into the
  Terms of Service (`views/partials/legal-terms-content.ejs`, "Data and
  privacy" section) — a merchant's single signup checkbox covers agreeing
  to both, plus having read the Privacy Policy. Incorporation by reference
  means a pointer, not a merge: DPA content stays on its own page and is
  versioned completely independently of `TERMS.version`. In particular,
  **adding, replacing, or dropping a subprocessor bumps `DPA.version`
  only** — it does not require a `TERMS.version` bump, since the Terms'
  own wording didn't change, only what the incorporated DPA says did.
- `LegalAcceptance` and `ShopperConsent` are **append-only**. Never call
  `.update()` on an existing row in either table — a new acceptance or
  consent decision always inserts a new row, never overwrites the last one.
  That's what makes them an audit trail instead of a settings table.
- `config/retention.js` is the only place a retention-window duration lives
  (e.g. `SHOPPER_RECEIPT_MONTHS`). Nothing else hardcodes a number of days
  or months. Changing any window there is a promise-breaking or
  promise-making change to whatever the published privacy policy ends up
  saying about retention — do it in the same change that updates that
  policy, never separately.
- `PurgeLog` and `EmailSuppression` are also never updated after being
  written, same append-only reasoning as `LegalAcceptance`/`ShopperConsent`
  above. `PurgeLog` is written exactly once per run, after it finishes
  (success or failure) — not a start-a-row-then-update-it pattern.
- `services/dataRetentionService.js`'s functions all default to
  `{ dryRun: true }` and only delete for real when a caller explicitly
  passes `{ dryRun: false }` — never assume live deletion is wanted. The
  scheduled daily job specifically is additionally gated by
  `RETENTION_PURGE_ENABLED` in `.env` (must be the literal string `"true"`);
  unset in every environment as of this writing, so it has only ever run in
  dry-run mode. See Not done yet.

## Built and working

- Merchant auth, Square OAuth, webhook-driven receipt capture. Proven
  end-to-end with real transactions through a live ngrok tunnel (Square and
  Clover both), not just sandbox — `verifySquareSignature()` in
  `routes/webhooks.js` does real HMAC-SHA256 verification against
  `SQUARE_WEBHOOK_SIGNATURE_KEY`, not a placeholder.
- NFC puck lifecycle: batch IDs, claim codes, QR activation
- "Assign to next sale" pairing — merchant arms a puck, rings one test sale,
  the webhook binds puck to register. Merchant never sees an ID.
- Receipt themes, Google review card, email capture modal
- AI receipt categorization + tax-deductibility flag
- Customer wallet with monthly summary, category chips, account menu
- Merchant dashboard: navy rail + overview page with real aggregates
- Stripe billing: card-upfront 30-day trial, then $49.99 USD/month
- Subscription gate on `/dashboard/*` (billing page stays reachable)
- Owner-only `/admin` view, gated by `ADMIN_EMAILS` in `.env`
- Landing page at `/`
- Legal consent capture: ONE checkbox at signup ("I agree to the Terms of
  Service, which include the Data Processing Agreement, and I have read
  the Privacy Policy") still writes THREE `LegalAcceptance` rows
  (TERMS/PRIVACY/DPA) — see Conventions for why. A re-acceptance
  interstitial redirects a merchant to `/legal/reaccept` if
  `config/legal.js` has a newer version of *any* of the three than what
  they last accepted, names only the document(s) that actually changed,
  and on submit writes a fresh row only for those — a merchant whose
  TERMS/PRIVACY are still current isn't re-stamped just because DPA moved
  (`services/legalAcceptanceService.js`'s `getStaleDocumentTypes()` is the
  shared source of truth for "what's actually behind" here). Tap-screen
  shopper consent (a plain transactional notice + a separate,
  unchecked-by-default marketing opt-in) writing `ShopperConsent` rows,
  logging declines the same way as grants
- Data retention infrastructure: `config/retention.js` defines every window;
  `services/dataRetentionService.js` purges expired receipts and idle
  shopper accounts, purges deactivated merchants past their grace period
  (anonymizes the `Merchant` row rather than deleting it — see Gotchas), and
  supports per-merchant or full-account shopper deletion for DSAR requests.
  Runs daily via `server.js`, dry-run only right now (see Conventions).
  Merchants can look up and delete a shopper's data themselves from
  `/dashboard/customer-emails`. `EmailSuppression` (a hash of the email, not
  plaintext) stops a deleted/unsubscribed shopper from being silently
  re-enrolled in marketing by a later receipt.

## Gotchas that have bitten us

- **Mount order in `server.js`.** `ownerFlag` must be mounted before the
  dashboard routes or `isOwner` arrives too late to render. Admin routes are
  mounted after billing. The legal re-acceptance gate follows the same
  `/dashboard`-with-a-`/billing`-exception pattern as the subscription gate,
  mounted right after it — a merchant who can't pay shouldn't be stopped on
  a legal screen before they can even reach billing to fix that.
- **Postgres enums.** You cannot `ALTER TYPE ... ADD VALUE` and then use that
  value as a `DEFAULT` in the same migration. Split it into two migrations.
- **Supabase connection.** Use the session pooler host, not the direct db host.
  The direct host fails to connect.
- **Stripe init.** Guard with `process.env.STRIPE_SECRET_KEY ? new Stripe(...)
  : null` — an empty key throws at startup and takes the whole server down.
- **Prisma client.** Every file shares one client via `require('../lib/prisma')`
  (or `./lib/prisma` from `server.js`). Don't create a separate
  `new PrismaClient()` anywhere — each instance opens its own connection pool,
  and enough of them exhausts Supabase's session-pooler limit and crashes the
  whole process, not just one request.
- **Passive NFC.** The puck has no power and no radio. It can never report
  "online" or "offline". Any device-status UI must be about setup state
  (linked / pairing / needs linking), never connectivity.
- **Deletion FK order.** `ShopperConsent.receiptId -> Transaction` and
  `LoyaltyCard.customerId -> Customer` are both `ON DELETE RESTRICT` —
  delete the child rows before the parent or Postgres rejects it.
  `LegalAcceptance.merchantId`, `ReceiptTheme.merchantId`,
  `LoyaltyProgram.merchantId`, and `Commission.merchantId` are ALSO
  RESTRICT, which means a `Merchant` row can never actually be hard-deleted
  once it has a `LegalAcceptance` row — which, per `config/retention.js`, it
  always will, forever. `purgeDeactivatedMerchants()` in
  `services/dataRetentionService.js` anonymizes the `Merchant` row in place
  instead of deleting it, deliberately, not as a workaround for a bug.

## Not done yet

- No Stripe webhook secret configured; the subscription gate polls Stripe
  instead (max once per 10 min per merchant) to compensate.
- The eight older dashboard pages still have prototype styling inside the new
  rail: receipts-hub, analytics, repeat-customers, customer-emails,
  merchant-receipts, pos-setup, theme-settings, merchant-expenses.
- Not deployed yet — in version control and pushed to GitHub
  (jordanchimenti/receiptap-backend) now, just not hosted anywhere real yet.
- `/legal/terms`, `/legal/privacy`, `/legal/dpa` are stub "coming soon" pages
  with no actual policy text yet — the checkboxes and acceptance-logging
  infrastructure are real and working, the documents themselves aren't
  written. Remember to bump the version in `config/legal.js` when they are
  (see Conventions). The retention windows in `config/retention.js` have the
  same problem — they're enforced in code but not documented anywhere a
  shopper or merchant can actually read them yet, since that's the same
  unwritten privacy policy.
- **Live data-purging has never been turned on.** `RETENTION_PURGE_ENABLED`
  is unset in every environment; the daily job has only ever run in dry-run
  mode. Before flipping it on: watch its `PurgeLog` output in production for
  a while first, and get the privacy-policy text written (above) so the
  windows it's about to start enforcing are actually documented somewhere.
- **The daily purge job is an in-memory-locked `setInterval` in
  `server.js`, not a real distributed cron** (same tradeoff as the
  affiliate-payout scheduler it sits next to — no `railway.json`/cron
  service is configured for this app). Fine for a single Railway process;
  would silently stop being sufficient if this is ever scaled to multiple
  instances, since each instance would run its own independent purge with
  no shared lock between them.
- **No unsubscribe mechanism exists yet.** `EmailSuppression` rows are only
  ever written today when a merchant deletes a shopper via the dashboard.
  There's no marketing-email sender in this app either (Resend is only ever
  used for password resets) — the "shopper unsubscribes" trigger has
  nothing to hook into until one of those gets built.
- **`deleteShopperEverywhere()` has no UI.** It's built and tested
  (`services/dataRetentionService.js`) but nothing calls it —
  `/dashboard/customer-emails` only wires up the merchant-scoped
  `deleteShopperByEmail()`. A full cross-merchant erasure currently has to
  be run by hand.

## Working style

- One step at a time, plain language, no assumed knowledge.
- Always verify a change landed before moving on — read the file back or grep
  for the thing that should now be there. Silent failures have cost hours.
- Run `node --check` on changed JS and render EJS templates with sample data
  before saying something works.
