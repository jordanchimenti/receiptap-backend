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
  legalAcceptanceService, shopperConsentService
- `config/legal.js` — single source of truth for legal-document and
  consent-string versions. See Conventions.
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
- `LegalAcceptance` and `ShopperConsent` are **append-only**. Never call
  `.update()` on an existing row in either table — a new acceptance or
  consent decision always inserts a new row, never overwrites the last one.
  That's what makes them an audit trail instead of a settings table.

## Built and working

- Merchant auth, Square OAuth, webhook-driven receipt capture
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
- Legal consent capture: three-checkbox signup gate (Terms/Privacy/DPA)
  writing `LegalAcceptance` rows; a re-acceptance interstitial that redirects
  a merchant to `/legal/reaccept` if `config/legal.js` has a newer version
  than what they last accepted; tap-screen shopper consent (a plain
  transactional notice + a separate, unchecked-by-default marketing opt-in)
  writing `ShopperConsent` rows, logging declines the same way as grants

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

## Not done yet

- **End-to-end Square webhook test has never run.** Needs a public URL —
  ngrok or real hosting. This is the biggest unproven piece of the product.
- `verifySquareSignature()` in `routes/webhooks.js` is a placeholder that
  returns `true`. Must implement real HMAC verification before launch.
- No Stripe webhook secret configured; the subscription gate polls Stripe
  instead (max once per 10 min per merchant) to compensate.
- The eight older dashboard pages still have prototype styling inside the new
  rail: receipts-hub, analytics, repeat-customers, customer-emails,
  merchant-receipts, pos-setup, theme-settings, merchant-expenses.
- Not deployed. Not in version control. Both worth doing early.
- `/legal/terms`, `/legal/privacy`, `/legal/dpa` are stub "coming soon" pages
  with no actual policy text yet — the checkboxes and acceptance-logging
  infrastructure are real and working, the documents themselves aren't
  written. Remember to bump the version in `config/legal.js` when they are
  (see Conventions).

## Working style

- One step at a time, plain language, no assumed knowledge.
- Always verify a change landed before moving on — read the file back or grep
  for the thing that should now be there. Silent failures have cost hours.
- Run `node --check` on changed JS and render EJS templates with sample data
  before saying something works.
