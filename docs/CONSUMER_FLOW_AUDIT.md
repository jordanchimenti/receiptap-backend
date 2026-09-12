# Consumer Automatic Receipt Flow — Architecture Audit + Migration Plan

Status: **DRAFT FOR APPROVAL — no code has been written.** This document is the deliverable requested; implementation starts only after this is approved.

---

## 0. Headline correction to the spec's assumptions

Before anything else: **push-notification infrastructure already exists.** The spec says "there is no... push-notification infrastructure... expect to find nothing" and asks this to be confirmed rather than assumed. It's confirmed, and it's false. See §1 and §11 for detail. This materially shrinks Phase 2 — it's mostly wiring plus real-device verification, not new infrastructure.

Everything else in the spec's "known stack" section checked out as described, with one flag: Shopify POS has real OAuth + webhook routes already in place (`routes/oauth-shopify.js`, `/webhooks/pos/shopify` in `server.js`), which is further along than "in progress" suggests — worth a quick confirmation from you on its actual completion status, though it has no bearing on this project either way.

---

## 1. What exists and can be reused as-is

**Push notifications (customer-side) — fully reusable, not new.**
`services/pushService.js` is a complete VAPID Web Push implementation (`web-push` npm package) with `isPushConfigured()`, `publicKey()`, `saveSubscription()`, `removeSubscription()`, `sendToCustomer(customerId, {title, body, url, tag})`. Backed by `PushSubscription` (`prisma/schema.prisma:809-822`), `public/sw.js`, `public/manifest.webmanifest`, and VAPID env vars already in `.env.example`. It's wired to a real trigger today: `services/notificationService.js`'s `notifyLoyaltyCardFull()` calls it via a `sendPushSafely()` wrapper, alongside an in-app `Notification` row and email — the exact three-channel pattern a new "receipt ready" notification should copy. Dead-subscription pruning (404/410 → delete the row) is real. Per CLAUDE.md, it's verified as far as FCM locally but never confirmed to a real device — that's the one open item, not "build push." Customer-side only; no merchant equivalent exists, none needed here. "Add to home screen" flow (`/account/install`, `Customer.homeScreenAddedAt`) also already exists, which matters directly for iOS web push (requires home-screen install).

**The scan pipeline — the right foundation, confirmed reusable end to end.**
- `services/scanReceiptService.js`'s `extractReceiptData(buffer, mimetype)` — Anthropic vision call, structured JSON schema, produces merchantName/date/total/lineItems/tax/subtotal/tip/taxNumber/etc. Reusable for PDF attachments essentially unchanged (Claude's API can take an image or PDF content block); needs a new sibling for HTML/text email bodies (see §2).
- `services/categorize-receipt.js`'s `categorizeScannedInBackground()` — fire-and-forget post-save categorization, works on any `ScannedReceipt` row regardless of how it was created.
- `lib/fileStorage.js`'s `putPrivate(folder, file, {prefix})` / `getPrivate(key)` — generic, Multer-shaped `{originalname, buffer, mimetype}` in, no image-specific logic. Stores to Supabase Storage (private bucket) today for scan photos; storing a raw `.eml` or a rendered email PDF is the identical call with a different `mimetype`. No changes needed.
- `lib/findDuplicateReceipt.js`'s `normalizeMerchant()` — existing merchant-name-normalization logic, currently scoped to same-customer duplicate detection. Directly reusable as a building block for merchant-registry matching (see §9), though it will need extending past "within one customer's wallet" to "across all customers, by sender domain."

**Receipt-lands-with-zero-user-action — already a real, working pattern, not something to invent.**
`services/receiptAutoSave.js`'s `autoSaveReceiptForKnownShopper()` runs after every Square `Transaction.create()` (`routes/webhooks.js:159`), matching via `ShopperIdentifier` (card-fingerprint hash or POS-reported email) and silently attaching the receipt to a wallet with no tap, no scan, no action. This is architecturally the closest existing thing to "email arrives → receipt appears in wallet automatically," and the identity-matching/consent reasoning behind it is a good precedent to reuse conceptually (though the *matching key* is different — sender/order-number/amount instead of card fingerprint).

**Data isolation between Merchant and Customer — airtight today, confirmed with no exceptions.**
`Customer` and `Merchant` share no FK, no relation field, anywhere in the schema. Sessions are `req.session.merchantId` / `req.session.customerId`, set and cleared independently (`routes/auth.js`, `routes/customer-account.js`), can coexist in one browser. No centralized auth middleware exists — 19+ route files each define a local `requireAuth`/`requireCustomerAuth`. A full search of every route file confirms `ScannedReceipt` is queried **only** from `requireCustomerAuth`-gated routes in `customer-account.js`, plus the two public token-only share routes (`receiptShare.js`, `splitGroupShare.js`, where "no auth middleware, on purpose — the token is the credential" is explicit by design). `merchant-dashboard.js`, `repeat-customers.js`, and `analytics.js` reference `Transaction` exclusively and never `ScannedReceipt`. **A merchant cannot see a customer's scanned or email-ingested receipts today, by construction, with no code path that would leak one.** This property must simply be preserved, not built.

**OAuth token-refresh precedent for the new EmailProvider connection.**
The POS OAuth integrations (Square/Clover/Lightspeed/Toast) are the right model to copy — not Stripe/PayPal Connect (which never store a token at all, since Stripe/PayPal hold custody). `services/cloverService.js`'s `getValidAccessToken(merchant)` — check expiry with a safety margin, refresh if stale, persist the new pair, notify on refresh failure — is the exact shape a Nylas grant-health check should follow, adapted to however Nylas's hosted-grant model actually needs re-authorization (Nylas manages the underlying Google/Microsoft token itself; the app holds a `grant_id` reference, not a raw OAuth token — confirm the exact re-auth signal Nylas sends during Phase 1 implementation).

**Webhook signature verification and idempotency conventions — both directly reusable patterns.**
Raw-body-before-`express.json()` mounting (`server.js:62-65`) and HMAC/`constructEvent`-style verification are established (Stripe, Square). Idempotency has two existing idioms: PK-reuse (`Transaction.id` = provider's own ID) and unique-column-plus-`findUnique` (`SplitPayment.stripePaymentIntentId`). A new email-provider webhook should use the second idiom, deduping on provider message ID, since the row it may or may not create (a `ScannedReceipt`) isn't 1:1-keyable to the message the way a POS transaction is.

**The wallet list already merges receipt kinds — a third kind is a non-event.**
`routes/customer-account.js` (~line 896) already maps both `Transaction` and `ScannedReceipt` rows into one common shape (`kind: 'transaction' | 'scanned'`, common `id/total/sortDate/merchantName/aiCategory` fields) and concatenates them into one sorted list. Adding `kind: 'email'` is additive to this exact function, not a restructure.

**Retention framework — good fit for the "keep forever" half of the requirement.**
`config/retention.js`'s named-constant-with-`Infinity`-for-never pattern, and `dataRetentionService.js`'s `{dryRun:true}`-by-default / `RETENTION_PURGE_ENABLED`-gated / `PurgeLog`-write-once shape, is the right place to add a window for confirmed email receipts + their original artifacts (or `Infinity`, matching the spec's "kept indefinitely for the customer's records"). See §9 for what's genuinely new alongside this.

---

## 2. What must be modified, and how invasive

**`services/scanReceiptService.js` — moderate, additive, not a fork.**
`extractReceiptData` currently only builds an `{type:'image', source:{...}}` content block. Add a sibling function (e.g. `extractReceiptDataFromEmail(htmlOrText, attachments)`) that reuses the exact same `RECEIPT_SCHEMA` and `INSTRUCTIONS` constants but sends a `{type:'text', text: ...}` content block (for HTML/plain-text bodies) or a PDF content block (for PDF attachments — Claude's API supports this natively; not currently exercised anywhere in this codebase, so treat as new-but-low-risk). This is genuinely additive: no existing call site changes, no existing behavior changes, the image path is untouched. Estimate: small, isolated change, low risk to the scan path.

**`routes/customer-account.js`'s wallet-list merge function — trivial, additive.**
Add a third branch mapping email-sourced `ScannedReceipt` rows (distinguished by the new `source` column, see §9) into the same merged shape with `kind: 'email'`. No restructuring of the existing two branches.

**`views/scanned-receipt.ejs` — small, additive.**
Add one conditional section: when `receipt.source === 'email'`, show an "Original receipt" link/download (opens the stored `.eml`/PDF via a new private-bucket proxy route, same pattern as the existing photo proxy). Everything else in this template — merchant, totals, line items, tax fields, category, warranty — renders identically regardless of source, since it's the same model. This is the one time the existing receipt view gets touched, and it's additive-only (a new conditional block, no existing block changed).

**`server.js` — one new raw-body mount, one new route-file require, one new poller registration.**
Mount order matters per CLAUDE.md's own documented gotcha. The new inbound email webhook needs `express.raw()` before `express.json()`, same list as the existing POS/Stripe webhooks. The new customer-facing connect/disconnect routes and the new backfill/classification poller each need one line, following exactly the existing patterns (`app.use(require('./routes/...'))`, `setInterval(...)` block).

---

## 3. What is genuinely new

- Hosted email-provider integration (Nylas, behind an `EmailProvider` interface) — OAuth connect flow, webhook receiver, message-fetch client.
- `MerchantRegistry` — an unconnected-merchant identity, keyed by normalized sender domain/name, distinct from the real `Merchant` tenant table. Confirmed nothing like this exists anywhere today (§9 detail).
- A message-level dedupe/audit table (`ProcessedEmailMessage`) — tracks provider message IDs permanently (per the spec's own requirement) without retaining content for anything that wasn't classified as a receipt.
- A source-document/original-artifact table (`ScannedReceiptSourceDocument`) — generalizes "here's the original proof" beyond just a scan photo, per the spec's own request in §4 of the original brief.
- A new account-level, revocable consent record for inbox connection (`EmailInboxConsent`) — neither existing consent table fits (§9 detail).
- Sender-heuristics-as-data (a config file or table of allowlisted domains/keyword patterns) so new senders (Square, Shopify, DoorDash, etc.) can be added without a code change.
- A classification/backfill background poller, following the existing `lightspeedPoller.js`/`toastPoller.js` `setInterval` shape (no real job queue exists in this codebase — see §7).
- `CardTransactionProvider` interface (stub only, §8).
- Push notification content/trigger for "receipt ready" (the transport already exists, §1).

---

## 4. What must NOT be rebuilt (confirmed still true after the audit)

- The Anthropic-based extraction schema/prompt (`RECEIPT_SCHEMA`/`INSTRUCTIONS` in `scanReceiptService.js`) — reused via a new adapter, not forked.
- `ScannedReceipt` as a model — extended additively (two new nullable/defaulted columns), never restructured.
- The wallet, categorization pipeline, receipt detail view, and share-link mechanism — all reused unchanged.
- `Transaction`, the POS webhook handlers, merchant dashboard, Stripe billing, CASL/`ShopperConsent`, `LegalAcceptance` — untouched by this project.
- `lib/fileStorage.js` — reused unchanged, no image-specific coupling to work around.

---

## 5. NFC/POS-specific code — merchant-path only, unaffected

`routes/oauth-square.js`, `oauth-clover.js`, `oauth-lightspeed.js`, `oauth-shopify.js`, `routes/toast.js`, `routes/webhooks.js`'s POS handlers, `services/squareService.js`, `services/cloverService.js`, `services/lightspeedSaleSync.js` + `lightspeedPoller.js`, `services/toastSaleSync.js` + `toastPoller.js`, `routes/pucks.js` (NFC tag provisioning/pairing), `routes/merchant-dashboard.js`, `routes/repeat-customers.js`, `routes/analytics.js`, `routes/billing.js`, `middleware/subscriptionGate.js`. All of these operate exclusively on `Merchant`/`Transaction` and are never touched by anything in this plan. None are "legacy to strip" — they're the live, paying-customer product running unmodified alongside the new consumer path.

---

## 6. Conflicts between the merchant and consumer paths

**None found.** Specifically checked:
- **Auth/session model** — fully independent (`merchantId` vs `customerId`), already proven to coexist safely in one browser. No new conflict introduced by adding email-connection state to `Customer`.
- **Receipt ownership** — `ScannedReceipt.customerId` is required and already the sole ownership key; email receipts follow the identical rule, no new ownership model needed.
- **Merchant vs. user tenancy** — the new `MerchantRegistry` table is deliberately a *third*, lightweight concept (an unconnected identity), not a modification to `Merchant`. A registry entry later "graduating" to a real `Merchant` row (someone signs up for the SaaS) is a one-way, additive reattribution (§9), never a schema change to either table.
- **Data isolation** — confirmed airtight today (§1); nothing in this plan adds a new route or query that could cross the boundary. The audit specifically checked for this and found no existing exception to preserve carefully — it's a clean line to hold.

---

## 7. How the hosted email provider and receipt detection fit the current architecture

**Webhook endpoint:** add to `routes/webhooks.js` (or a new `routes/emailWebhook.js` if you'd rather keep POS and email webhooks in separate files — both are reasonable; recommend the new file, since this webhook's payload shape, verification method, and downstream logic have nothing in common with the POS handlers it would otherwise sit beside). Either way, one new raw-body mount in `server.js`, following the existing pattern exactly.

**No job queue exists in this codebase — this is a real architectural decision point, not a gap to silently fill.** A thorough search found zero queue libraries (Bull/BullMQ/pg-boss/etc.), zero Redis or equivalent, anywhere in `package.json`, env vars, or CLAUDE.md. Every piece of "background work" today is a `setInterval` registered directly in `server.js`, running in the single Node process Railway deploys, with hand-rolled in-memory concurrency flags (no real lock). CLAUDE.md itself flags this as a known, accepted tradeoff for the current single-instance deployment.

Recommendation: **do not introduce Redis/BullMQ for this feature.** It would be genuinely new infrastructure (new external service, new cost, new failure mode) for a single-founder, single-Railway-process app that has never needed one. Instead, extend the existing pattern faithfully:
1. The webhook handler does only the fast, synchronous part — signature verification, a cheap first-pass filter (sender domain / subject keywords), and writes a minimal `ProcessedEmailMessage` row with `status: 'pending'` if it passes the filter. No AI call happens inside the webhook request.
2. A new poller (`services/emailReceiptPoller.js`, same shape as `lightspeedPoller.js`) runs every N minutes, picks up a small batch of `pending` rows, fetches the full message body from Nylas, runs classification + extraction, and either creates a `ScannedReceipt` (+ source document + finalizes the `ProcessedEmailMessage` row as `receipt`) or marks it `rejected` and discards the fetched content without persisting it.
3. The bounded 90-day backfill on first connect uses the identical poller, just seeded with a larger initial batch of message IDs from Nylas's list-messages API, chunked across multiple ticks so it never blocks the event loop for long — same "harmless duplication across instances, no correctness risk" tradeoff CLAUDE.md already accepts for the Lightspeed poller.

This keeps the feature consistent with everything else in the app, at the honest cost of the same single-instance ceiling every other background job here already has. If you'd rather take on Redis/BullMQ now (e.g. because you expect this to need real retry/backoff/rate-limiting semantics beyond what a poller can reasonably do), say so and the plan changes — but that's a call only you should make, given it's a standing infrastructure commitment, not a one-time build cost.

**Storage:** no new storage backend. `lib/fileStorage.js`'s existing private-bucket `putPrivate`/`getPrivate` handles the raw `.eml`/PDF exactly as it handles scan photos today.

---

## 8. How the card-link interface fits without gating a receipt

Define `services/cardTransactionProvider.js` as a plain interface/type shape (Plaid/Flinks-style fields: `merchantDescriptor, amountCents, postedDate, pending, accountRef`) with no implementation — a stub module other code can import against later. No schema changes in this project; a `CardTransaction` table (if/when a real provider is integrated) is Phase 3's problem, not this plan's. The matcher design (amount + date-window + normalized merchant descriptor, explicitly not time-of-day) is documented here as a spec for Phase 3, not built. Nothing about email ingestion or the `ScannedReceipt` creation path references this interface at all in Phase 1 or 2 — card data, when it exists, would only ever *enrich* an already-created receipt (confidence score, dedupe hint), never gate its creation, satisfying the "never require a card-transaction match" rule by simply never wiring the two together in the first place.

---

## 9. The existing receipt creation path, and how email-parsed data maps onto it

**POS path (`Transaction`):** requires a real, connected `Merchant` (non-nullable FK) — confirmed via schema. Wrong model for email receipts, which mostly come from senders with no ReceipTap account.

**Scan path (`ScannedReceipt`):** requires only a `Customer` (non-nullable FK) and a free-text `merchantName` — no `Merchant` FK exists on this model at all. This is the correct model for email receipts, for four concrete reasons: it already has zero merchant-connection dependency; its required-customer/optional-everything-else shape matches "an authenticated customer's own inbox, arbitrary unconnected sender" exactly; `imageUrl`'s storage precedent generalizes cleanly to "store the original artifact"; and the rich tax-substantiation field set (subtotal/tax/tip/taxNumber/buyerName/etc.) already matches what an email receipt needs to capture, field for field.

**Creation code:** `routes/customer-account.js`'s `POST /account/receipts/scan/confirm` — currently the sole `prisma.scannedReceipt.create()` call site. The email path should call the identical Prisma create (or a small shared helper extracted from it, if there's meaningfully more than "map fields and call create" — assess this during implementation; based on today's code it looks like a direct reuse, not an extraction).

**Proposed additive changes, each justified individually:**

1. **`ScannedReceipt.source`** — `String`, default `'photo'`. A plain string (not a Postgres enum), matching this codebase's existing convention of representing small closed vocabularies as strings with the valid values documented in a comment (e.g. `SplitPayment.method`) rather than a true enum — this also sidesteps the enum-plus-default-in-one-migration gotcha CLAUDE.md documents. Existing rows get `'photo'` automatically via the column default; nothing about them changes. *Justification:* the wallet list, the receipt view's "Original receipt" link, and future analytics all need to know which pipeline produced a row.

2. **`ScannedReceipt.merchantRegistryId`** — `String?`, FK to new `MerchantRegistry`. Nullable, so every existing row (and every future *photo* scan, which has no sender domain to register) is unaffected. *Justification:* required to implement the spec's own request — an unconnected merchant identity that a real `Merchant` can later inherit receipts from.

3. **New table `MerchantRegistry`** — `id, normalizedName, senderDomain (unique, nullable), displayName, claimedByMerchantId (nullable FK to Merchant), createdAt`. *Justification:* confirmed nothing resembling this exists anywhere in the schema or codebase today (explicit search, zero hits). This is the piece the spec explicitly asked the audit to design. "Claiming" (a real Merchant signing up later and inheriting a registry's receipts) is a single `UPDATE ... WHERE merchantRegistryId = ?` reattribution query — additive, no migration of existing receipt rows needed, and safe to defer the actual claim-flow UI to a later phase while still creating the table now.

4. **New table `ProcessedEmailMessage`** — `id, emailConnectionId, providerMessageId (unique), decision ('pending'|'receipt'|'rejected'), scannedReceiptId (nullable), processedAt`. *Justification:* the spec explicitly requires permanent dedupe on provider message ID and an audit trail, but also requires non-receipt content to be deleted immediately, never retained. Neither existing idempotency idiom (PK-reuse, or a unique column on the receipt itself) covers "we looked at this message and rejected it" — that fact has no receipt to attach a unique column to. This table is the minimal thing that satisfies both requirements at once: it stores only an ID and a decision, never body content.

5. **New table `ScannedReceiptSourceDocument`** — `id, scannedReceiptId, type ('email_eml'|'email_pdf'|'attachment_pdf'), storageKey, contentHash, capturedAt`. *Justification:* this is exactly what §4 of the original spec asked the audit to design — one consistent original-artifact model. Scoped to `ScannedReceipt` only for this project (not a generic polymorphic table also covering `Transaction`) since POS receipts have no artifact-storage precedent or requirement today; the table's shape doesn't preclude extending it to `Transaction` later if you ever want that, it just isn't required now. `imageUrl` on `ScannedReceipt` stays exactly as-is for photo scans — this table is additive for email sources only, not a replacement.

6. **New table `EmailConnection`** — `id, customerId, provider ('nylas'), providerAccountId, grantId, status ('connected'|'disconnected'|'error'), connectedAt, disconnectedAt, lastSyncedAt`. *Justification:* mirrors the POS OAuth token-storage shape (§1) adapted to Nylas's grant-based model — confirm during Phase 1 implementation exactly what Nylas returns and what "needs re-auth" looks like on their side, since this audit couldn't verify Nylas's specific API contract against live code the way it could for Square/Clover.

7. **New table `EmailInboxConsent`** — `id, customerId, grantedAt, revokedAt (nullable), consentVersion`. *Justification:* neither existing consent table fits. `ShopperConsent` is required-non-nullable to a specific `Transaction` — structurally wrong for an account-level, no-receipt-yet grant. `ShopperLegalAcceptance` is correctly account-level but is an append-only "did you accept this text" log with no revocation concept — inbox access needs a granted/revoked lifecycle `ShopperLegalAcceptance` was never designed for. This new table borrows the versioning idea from one and the granted/revoked lifecycle from the other, rather than forcing a bad fit into either.

**Net new migration footprint:** 2 new columns on `ScannedReceipt`, 5 new tables. All additive, all nullable-or-defaulted, zero changes to any existing column, zero renames, zero data migration of existing rows required.

---

## 10. Security, privacy, and app-store issues, with mitigations

- **Inbox access is the most sensitive thing this product will do.** Mitigation: Nylas (already Google CASA-certified) so this app never handles raw restricted-scope Gmail tokens directly; strict "classify, then immediately discard non-receipts" data flow (§9's `ProcessedEmailMessage` design enforces this structurally, not just by policy); a new versioned consent record (`EmailInboxConsent`) separate from existing CASL/`ShopperConsent` records, which govern a different relationship (merchant tap-screen, not ReceipTap's own account-level notifications).
- **Privacy policy update required.** `config/legal.js`'s existing version-bump discipline applies directly — add a new section to `SHOPPER_PRIVACY` (the wallet-customer privacy doc) stating plainly what's retained (confirmed-receipt originals, indefinitely) and what isn't (anything else, deleted immediately on rejection), and bump its version per the file's own documented rule, which will re-trigger the existing re-acceptance interstitial for wallet customers.
- **One-tap disconnect.** Revokes the Nylas grant (stops ingestion) but does not delete existing `ScannedReceipt`/`ScannedReceiptSourceDocument` rows — matches the spec's explicit requirement and the existing pattern where account deletion (`deleteShopperEverywhere`) is the only thing that removes data, disconnection is not.
- **Google restricted-scope policy.** Using Nylas addresses the CASA-assessment burden, but ReceipTap's own use of the data still must never extend beyond receipt creation — no ads targeting, no sale, and explicitly no use in a future rewards/CPG/card-linked-offer system. Worth stating this constraint explicitly in the privacy policy now, since it forecloses a design mistake in the (separate, future) rewards project before it can happen.
- **PIPEDA / data isolation.** Confirmed already airtight (§1, §6) — no new isolation work needed, only "don't break what's already true."
- **App Store / Play requirements.** Not triggered in Phase 1 or 2 as scoped (no native app is being built in this project). If Phase 2's platform recommendation (§ below) is ever revisited toward a wrapped/native app, flag then: privacy nutrition labels, account-deletion self-service, Sign in with Apple if third-party sign-in is offered to iOS users.

---

## 11. Assumptions in the original spec that are wrong for this codebase

1. **"No push-notification infrastructure"** — false. A complete, wired, VAPID Web Push pipeline already exists for the customer/wallet side (§1). This is the one assumption correction that changes a phase's scope materially.
2. **Shopify POS status** — described as "in progress," but real OAuth (`routes/oauth-shopify.js`) and webhook (`/webhooks/pos/shopify`) routes already exist. Worth a quick confirmation from you on actual completion, though it doesn't affect this project.
3. Everything else in the spec's "known stack" section (Node/Express/EJS/Postgres, Square/Clover OAuth+webhooks, Anthropic-based parsing, scanner, wallet+categorization, merchant onboarding/dashboard/Stripe billing, CASL consent storage, GDPR/privacy pages, NFC tag provisioning) checked out exactly as described.
4. The spec's assumption that there's "no rewards system" and "no points ledger" is confirmed correct — nothing resembling either exists anywhere in the schema.

---

## 12. Phased implementation plan

### Phase 1 — Hosted email connect, detection, adapters, receipt creation, web wallet surfacing

**Goal:** a real customer can connect Gmail/Outlook, and a real receipt email produces a normal `ScannedReceipt` visible in the existing wallet, with its original attached. No mobile, no card, no rewards, no push yet (push is Phase 2, even though the transport already exists, to keep Phase 1's test surface focused on "does parsing work well against real inboxes" per your own stated goal for this phase).

**Files touched/added:**
- New: `prisma/migrations/..._add_email_ingestion` (5 tables + 2 columns, §9)
- New: `services/emailProviderService.js` (Nylas OAuth start/callback, webhook signature verification, message fetch/list — behind an `EmailProvider` interface so the vendor is swappable)
- New: `services/emailReceiptService.js` (first-pass filter, classification, orchestrates extraction + `ScannedReceipt` + `ScannedReceiptSourceDocument` + `ProcessedEmailMessage` creation)
- Modified: `services/scanReceiptService.js` (new `extractReceiptDataFromEmail` sibling function, additive)
- New: `services/emailReceiptPoller.js` (setInterval-based classification worker + bounded backfill, mirrors `lightspeedPoller.js`)
- New: `routes/emailWebhook.js` (inbound Nylas webhook)
- New: `routes/customer-email-connect.js` (`/account/connect-email/start`, `/return`, `/disconnect` — mirrors the Stripe/PayPal Connect route shape)
- New: `config/emailSenderHeuristics.js` (allowlisted domains/keyword patterns as data)
- Modified: `server.js` (one raw-body mount, two route requires, one setInterval registration)
- Modified: `routes/customer-account.js` (wallet-list merge gets a third `kind: 'email'` branch)
- Modified: `views/scanned-receipt.ejs` (additive "Original receipt" section)
- New: `views/account-email-connect.ejs` (connect/disconnect UI, modeled on `customer-settings.ejs`'s existing Connect-card pattern)
- Modified: `config/legal.js` / `SHOPPER_PRIVACY` content (version bump, new retention/consent disclosure)
- Modified: `config/retention.js` (new window constant for confirmed email receipts + originals, likely `Infinity` per the spec's "kept indefinitely" requirement)

**New env vars/secrets:** Nylas API key, Nylas webhook signing secret, Nylas client ID (exact names confirmed once the Nylas integration is scaffolded).

**External accounts needed:** a Nylas account/application (their hosted OAuth app, already CASA-certified — this is the whole point of using them instead of running your own restricted-scope Google OAuth app).

**Risk to the merchant path:** very low. No merchant-facing file is touched. The only shared file is `server.js` (additive lines only) and `routes/customer-account.js` (one new branch in one function, not touching the Transaction side of that function).

**How to test:** connect a real personal Gmail/Outlook to a test ReceipTap account; forward or receive real receipts from the "expected high-volume senders" list (Square, Shopify, Uber Eats, DoorDash, Amazon); confirm each produces a correct `ScannedReceipt` with accurate fields and a downloadable original; confirm a non-receipt email (a newsletter, a personal email) is never persisted; confirm the 90-day backfill runs without blocking other requests; confirm disconnect stops new ingestion but leaves existing receipts intact.

### Phase 2 — Push/deep-link, notification policy

**Recommendation on platform: keep the existing PWA + Web Push direction** — do not build a native or Expo/React-Native app for this. Reasoning: the infrastructure already exists and is already PWA-shaped (`manifest.webmanifest`, `sw.js`, home-screen install flow); a solo founder on an Express/EJS codebase gets the least new surface area by finishing what's already 80% built rather than starting a second codebase/toolchain; deep-linking to a specific receipt is trivial with Web Push's `url` payload field, which `sendToCustomer` already supports. The known cost (iOS requires home-screen install first) is already documented and already has a UI flow built for it.

**Files touched/added:** `services/notificationService.js` (new `notifyEmailReceiptReady()`, mirrors `notifyLoyaltyCardFull()`'s three-channel shape but push+in-app only, no email — matching the spec's "one push per Receipt ready" policy), called from `emailReceiptService.js` once a `ScannedReceipt` is created. No new tables.

**New env vars/secrets:** none — VAPID keys already exist.

**External accounts:** none new.

**Risk to merchant path:** none — `MerchantNotification`/merchant push is untouched (doesn't exist, out of scope).

**How to test:** the one real gap flagged in §1 — confirm actual delivery to a real device (iPhone home-screen-installed PWA, Android Chrome) for the first time, not just the FCM handoff. Confirm deep link opens the exact receipt. Confirm rate-limiting/batching behavior if multiple receipts land close together.

### Phase 3 — Card-link provider integration + missing-receipt nudge

**Files touched/added:** a real `services/cardTransactionProvider.js` implementation (Plaid or Flinks, pending your choice), a new `CardTransaction` table (out of scope to design in this document per your own instruction — flagged as a future migration), a matcher service (amount + date-window + normalized descriptor), and a "missing receipt" nudge notification reusing the Phase 2 push channel.

**Risk to merchant path:** none anticipated, but not designed in detail here per your instructions — this phase gets its own audit when you're ready for it.

**Rewards/points are explicitly not part of any phase above or after** — a separate future project, per your instructions.

---

## 13. Non-inline receipt content: PDF attachments and link-only receipts

A real gap surfaced after Phase 1 shipped and was tested end-to-end against a live Nylas connection: not every receipt email actually contains its own data. Three distinct patterns exist, with three different levels of support:

**Pattern A — data written directly in the email body.** The common case (Amazon, Uber, DoorDash, Instacart, Shopify order confirmations, Square's auto-receipt emails). Fully supported since Phase 1, verified live.

**Pattern B — data inside a PDF attachment, email body says only "your invoice is attached."** Built and verified live in this pass. `services/emailReceiptService.js`'s `processPendingMessage` now runs body-only extraction first (unchanged, keeps the common case cheap); only if that fails to yield a merchant name and total does it download up to `MAX_PDFS_FOR_EXTRACTION` (2) PDF attachments under `MAX_PDF_BYTES_FOR_EXTRACTION` (15MB each) and retry extraction with the PDF(s) added as native `document` content blocks alongside the email text — one more adapter into the same `extractReceiptDataFromEmail`/`RECEIPT_SCHEMA`, not a second parser, per this document's own "add an adapter, don't fork the parser" rule. Downloaded buffers are reused for the source-document storage step below, never fetched twice. **A real, separate bug found and fixed in the same pass**: the existing PDF-attachment detection (both the new fallback and the pre-existing "store the original PDF" step) matched `attachment.content_type === 'application/pdf'` with strict equality — but real providers commonly report a Content-Type *with* parameters (`application/pdf; name=invoice.pdf`), which never matched. This means the original "attach the merchant's PDF as this receipt's source document" feature had been silently broken since it was written, for any attachment sent with a parameterized Content-Type header — not an edge case, the common case. Fixed by comparing only the base media type (splitting on `;`).

**Pattern C — no real data in the email at all, just a "click here to view your receipt" link to a page on the merchant's own website.** **Not built.** The pipeline never fetches an external URL found in a message; if the actual figures only exist behind a link, this pipeline cannot see them today. Scoped below, deliberately NOT implemented, pending a real go-ahead:

- **What it would take**: detect a plausible "view receipt/invoice/order" link in the email body (anchor text or button, not every link — a receipt email's footer is full of unsubscribe/social/legal links that are never the receipt itself), fetch that one URL server-side, reduce the returned HTML to text the same way `htmlToPlainText` already does for a message body, and feed it through the same `extractReceiptDataFromEmail`-style adapter as a third input.
- **The real risk this adds, that nothing built so far carries**: the server would be making an outbound HTTP request to a URL whose destination is influenced by the *content of an inbound email* — a textbook SSRF vector. A message engineered to include a link to `http://169.254.169.254/...` (cloud metadata), an internal admin host, or a loopback address could turn "read my receipt" into "make my server fetch something it shouldn't." This is categorically different from the PDF case above, where the fetched resource is a specific attachment ID already scoped to a specific message on a specific authenticated grant.
- **What a real implementation would need before any code**: HTTPS-only, resolve the hostname and reject anything in a private/loopback/link-local range *before* connecting (and re-check after any redirect — a public hostname can still resolve to or redirect to a private IP), a strict timeout and response-size cap, and probably restricting the first version to links whose domain is already on the `SENDER_DOMAINS` allow-list in `config/emailSenderHeuristics.js` rather than following an arbitrary link found in arbitrary inbound mail. Even with all of that, some receipt pages sit behind a login the server has no session for (common for airline/hotel confirmations) and would just return a login page — the classification step needs to fail closed on that, not mistake a login page's text for a receipt.
- **Recommendation**: worth building once Pattern B has real usage data justifying it, as its own reviewed change — not a natural extension of the PDF-fallback work above, since the trust boundary it crosses is fundamentally different.

---

## Open questions for you before Phase 1 starts

1. Nylas vs. Unipile — this audit found no concrete reason in the codebase to prefer one over the other (neither has any existing footprint here); proceeding with Nylas per your stated default unless you say otherwise.
2. Whether to keep the email webhook in `routes/webhooks.js` or a new `routes/emailWebhook.js` (recommended) — no wrong answer, just a preference.
3. Confirm Shopify POS's actual completion status (§0/§11) — informational only, doesn't block this plan.
4. Whether `MerchantRegistry`'s "claim" flow (a real Merchant inheriting registry receipts) needs any UI in Phase 1, or whether creating the table now and building the claim flow later (once real registry data exists to design against) is acceptable — this document assumes the latter.
