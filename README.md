# ReceipTap Core Backend

A complete, runnable Node/Express/Prisma/PostgreSQL backend for ReceipTap — merchant accounts, NFC puck claiming, Square POS integration, digital receipts, and receipt collections (both merchant-side and customer-side).

## What's actually here

- **server.js** — the real entry point. Mounts every route module below.
- **prisma/schema.prisma** — ONE consolidated schema: `Merchant`, `Puck`, `Transaction`, `ReceiptTheme`, `Customer`, all relations resolved.
- **routes/auth.js** — merchant signup, login, logout (session-based)
- **routes/pucks.js** — `GET /r/:puckId` (permanent NFC tap URL, routes based on puck status), `GET`/`POST /claim/:puckId` (activation with claim code)
- **routes/oauth-square.js** — `GET /oauth/square/connect` + `/callback` (one-time merchant→Square handshake), `GET /dashboard/pos-setup` (auto-fetches Square locations, assigns pucks to registers)
- **routes/webhooks.js** — `POST /webhooks/pos/square` (ongoing shared endpoint, saves every sale as a `Transaction`, updates the matching puck)
- **routes/receipt.js** — `GET /receipt/:transactionId` (renders the branded customer receipt)
- **routes/merchant-dashboard.js** — sales history (`/dashboard/receipts`) + combined tabbed view (`/dashboard/receipts-hub`)
- **routes/merchant-expenses.js** — purchases saved as business expenses (`/dashboard/expenses`)
- **routes/customer-account.js** — separate consumer wallet (signup/login/`/account/receipts`)
- **scripts/generate-batch.js** — generates puck ID batches for hardware orders
- **views/*.ejs** — every page: login, signup, POS setup, receipt, dashboards, wallet

## Setup

```bash
npm install
cp .env.example .env
# edit .env with your real DATABASE_URL, SESSION_SECRET, and Square app credentials

npx prisma generate
npx prisma migrate dev --name init

npm start
```

Server runs at `http://localhost:3000`. Visit `/signup` to create your first merchant account.

## Verified in this build

- Every route file passes `node --check` (no syntax errors)
- Server boots cleanly — all 7 route modules mount without conflict, session/view-engine middleware wired correctly (confirmed by running it; it only fails past that point on Prisma client generation, which requires network access to Prisma's binary CDN unavailable in the sandbox this was built in — this will work normally on your machine)
- Every EJS view was rendered with sample data and visually checked (receipt, merchant dashboard, expenses, customer wallet, combined tabs)

## What's still a placeholder / needs your input

- **Square credentials** — get `SQUARE_APP_ID` / `SQUARE_APP_SECRET` from developer.squareup.com, add your app's redirect URI as `{your-domain}/oauth/square/callback`
- **Square webhook signature verification** (`routes/webhooks.js`) — currently returns `true` unconditionally; wire up real HMAC verification using Square's webhook signature key before going live
- **Shopify POS adapter** — Square is fully built; Shopify/Clover/Toast adapters follow the same pattern (OAuth connect/callback + a provider-specific webhook handler) but aren't built yet
- **Password reset flow** — not included; add when needed

## Handling multiple registers at ONE location (same Square login)

Square's Locations API returns one entry per physical store, not per checkout lane — so a merchant with 2+ registers under one location needs a second layer, since a shared login doesn't distinguish which physical terminal rang up a sale.

**How this is solved:** rather than requiring the merchant to manually pair devices through Square's Terminal API (a heavier setup flow), the system observes real sales as they happen. Square includes a `device_id` on payments taken via Square Terminal hardware — `routes/webhooks.js` captures this on every `Transaction`. `GET /dashboard/pos-setup/devices` then shows the merchant every distinct device ID that's actually rung up a sale recently, and they assign a puck to each one via `views/device-assignment.ejs`.

**Matching priority in the webhook** (`routes/webhooks.js`): device-level match first (`posDeviceId`), falls back to location-level match (`posLocationId`) if no device ID was reported or no device-level puck is assigned — so single-register merchants need zero extra setup, and this only becomes relevant once a merchant actually has multiple lanes.

**One real limitation, worth knowing:** `device_id` is only present for sales taken through Square Terminal hardware — a merchant using the Square POS app on a plain tablet/phone (no dedicated Terminal device) won't get a `device_id` at all, so this only helps for merchants with actual Square Terminal units per lane. For POS-app-only multi-register setups, location-level matching is the ceiling right now.

## Customer email segmentation (new / repeat / lapsed) for targeted marketing

The existing Customer Emails page now segments every captured email into three groups, with filter tabs and segment-aware CSV export — so a merchant exporting for a "come back" campaign gets a genuinely different list than one exporting for a loyalty offer.

- **routes/email-capture.js** — `getSegmentedCustomers()` classifies each customer by visit count and recency:
  - **New** — exactly 1 visit ever
  - **Repeat** — 2+ visits AND their last visit was within 60 days (still actively engaged)
  - **Lapsed** — last visit was 60+ days ago, **regardless of past visit count** — this overrides "repeat," since a customer who visited 6 times but hasn't been back in 4 months needs a win-back message, not a loyalty one
  - `GET /dashboard/customer-emails?segment=new|repeat|lapsed` filters the page; `GET /dashboard/customer-emails/export?segment=...` exports just that segment's CSV
- **views/customer-emails.ejs** — tabs showing live counts per segment, color-coded segment tags in the table, and the export link **dynamically updates its `href` to match whichever tab is active** — exporting from the Lapsed tab downloads only lapsed customers, not the full list.
- A plain-language hint at the bottom explains what each segment means for marketing (new → welcome nudge, repeat → loyalty/upsell, lapsed → win-back).

**Tested against 7 boundary cases before building the UI**, since the recency threshold has an important edge case: a highly loyal customer (5+ visits) who's gone quiet for 61 days must classify as `lapsed`, not `repeat` — verified exactly that case, plus the boundary at precisely 60 vs. 61 days. Then tested the full interactive flow with a real browser: clicking each tab correctly filters the table and updates the URL, and — the part most likely to have a silent bug — **downloaded the actual exported CSV file and confirmed its contents** while on the Lapsed tab, verifying it contained only the lapsed customer rather than the full list.

## Analytics page (one chart, tab-switchable metrics)

Single full-width chart with a tab switcher above it — deliberately not multiple small charts crammed onto one page, since a full-width chart is more readable and this pattern scales cleanly as more metrics get added later (matches how Stripe/Shopify analytics dashboards are built).

- **routes/analytics.js** — `GET /dashboard/analytics?days=30` (defaults to 30). Computes two datasets server-side: revenue per day, and new-vs-repeat customer counts per day.
- **The new-vs-repeat logic is the trickiest part, and was tested specifically for it**: "new" means this is a customer's first-ever transaction with this merchant — determined via `groupBy` across their **entire** history with this merchant, not just within the selected date window. This matters: a customer who's been shopping there since May shouldn't get counted as "new" just because their most recent visit happens to fall inside a 30-day window that starts in June. Verified this exact case in isolation before building the view — a long-time customer's in-window visit correctly classified as repeat, not new.
- **views/analytics.ejs** — Chart.js (loaded from cdnjs), a line chart for revenue and a stacked bar chart for new-vs-repeat, switched client-side via tabs with no page reload (`chart.destroy()` before re-rendering, confirmed via testing that switching back and forth repeatedly doesn't leave chart artifacts).
- Added to the shared dashboard nav.

**Testing note:** first test run showed a `Chart is not defined` error — turned out to be this sandbox's network blocking `cdnjs.cloudflare.com`, not a real bug (same category of limitation hit earlier with Google's Sign-In script). Verified this by re-testing with a locally-served copy of the identical Chart.js library, which rendered both charts and tab-switching with zero errors — confirming the code itself is correct and the failure was purely an artifact of this build sandbox, not something that will happen for real merchants.

## Bulk PDF receipt export (real document copies, not just data)

The CSV export on the Customer Receipts tab is spreadsheet data (rows of numbers). This is different: actual formatted PDF documents — one per receipt, looking exactly like what the customer saw (their chosen layout, branding, logo) — bundled into a ZIP for the merchant's own filing or their accountant.

- **services/generate-receipt-pdf.js** — reuses the exact same `receipt.ejs` template (and whichever layout/theme the merchant has chosen) that customers see live, rendered via a headless browser (Playwright) instead of duplicating a separate PDF-specific template. Reuses ONE browser instance across a whole batch rather than launching fresh per receipt, for speed.
- **routes/pdf-export.js** — `GET /dashboard/receipts/pdf-export?from=&to=`, queries transactions in range (capped at 200 per export as a guardrail against a huge date range taking a very long time), generates a PDF per receipt, and streams a ZIP download using `archiver`.
- Linked from the Customer Receipts tab, next to the existing CSV export.

**Two real bugs caught and fixed during testing, not just visual review:**
1. **Blank space bug**: the first generated PDFs had a large empty white area below a short receipt, because the PDF page defaulted to a fixed page height instead of sizing to the actual content. Fixed by measuring the real rendered content height and sizing the PDF page to match — verified by converting the before/after PDFs to images and comparing them directly.
2. **Dependency API-mismatch bug**: the `archiver` package's latest major version (v8) switched its export style entirely (ESM classes instead of the classic function-call API most documentation and this code assumes) — `archiver('zip', {...})` would have crashed in production with "archiver is not a function." Caught this by actually running the ZIP-bundling code rather than just installing the package and assuming it worked; pinned `package.json` to `^6.0.2`, which has the expected API, and re-verified the full pipeline works end-to-end.

**Verified with a real, complete pipeline test**: generated 3 realistic receipts as actual PDFs (confirmed valid `%PDF` file headers, reasonable file sizes), bundled them into a real ZIP, and used `unzip -l` to confirm the archive contains exactly 3 correctly-named files, not just that the code ran without throwing.

**Deployment note:** added a `postinstall` script (`playwright install chromium`) to `package.json` so Railway/Render automatically fetches the browser binary this feature needs during deployment — without it, PDF generation would fail on a fresh deploy with a missing-browser error, the same issue hit and resolved while building this in the sandbox.

## Repeat customer analytics (AI-recognized, export to your own email tool)

Merchants can see which customers have saved a receipt from them 2+ times — visit count, total spent, last visit, and their most common purchase category (using the AI categorization data already captured per receipt).

**Deliberately does NOT send marketing email on the merchant's behalf.** An earlier version of this feature included AI-drafted discount offers sent via raw SMTP — that was reconsidered and removed after weighing it honestly: marketing email legally requires unsubscribe handling and a sender address (CAN-SPAM), and raw SMTP without proper domain reputation/SPF/DKIM tends to land in spam regardless. Rebuilding what dedicated email platforms already do well wasn't the right call. Instead:

- **routes/repeat-customers.js** — the repeat-customer detection query (2+ transactions, aggregated visit count/total spent/top category via the same AI category data) and a CSV export.
- **views/repeat-customers.ejs** — simple table + "Export CSV" button, with a hint pointing merchants toward importing it into Mailchimp/Klaviyo/whatever they already use — tools actually built for compliant, deliverable marketing.
- Added to the shared dashboard nav.

**Tested with a real browser against a live mock server**: confirmed the table renders correctly (including graceful fallbacks — a customer with no name shows their email instead, no category shows a plain dash rather than breaking), and the CSV export was verified to actually download real, correctly-formatted content via Playwright's download API, not just checking the route returns 200.

**Setup required:** none beyond what categorization already needs (`ANTHROPIC_API_KEY`) — no SMTP, no email-sending compliance surface to maintain.

## Wallet search (find a past receipt for a return)

- **routes/customer-account.js** — `GET /account/receipts` now accepts `?search=<business name>` (case-insensitive partial match) and `?from=&to=<date range>`, filtered server-side via Prisma so it stays fast as a wallet grows over time rather than filtering in the browser.
- **views/customer-wallet.ejs** — search form (business name + date range) above the receipt list. Shows a distinct "no receipts match your search" state (vs. the "no receipts saved yet" empty state), and a "Clear search" link when a filter is active.

**Tested with a real browser against a live mock server** (not just rendering the markup): confirmed 3 receipts show by default, searching "Hardware" correctly filters down to exactly 1 matching result, the search term persists in both the input field and the URL after submitting, and searching for a nonexistent business correctly shows the no-results state rather than an empty/broken page.

## AI receipt categorization (the real "Stub" vision, now built)

Every receipt a customer saves gets automatically classified by spending category and checked for possible tax deductibility — using the actual line-item data captured from the POS, not photo OCR. This is the structured-data advantage over photo-based competitors like Expensify that was the original differentiator.

- **services/categorize-receipt.js** — calls the Anthropic API with the merchant name + line items, asking for a category (from a fixed list), a tax-deductibility suggestion, and a one-sentence reasoning. Validates the response against the known category list (falls back to "Other" if the model returns something unexpected) and strips markdown code fences defensively before parsing, since models sometimes wrap JSON in ```` ```json ```` fences despite being told not to. **Never throws** — any failure (missing API key, network error, malformed response) returns `null`, and callers treat that as "skip for now," not an error.
- **prisma/schema.prisma** — `Transaction.aiCategory`, `aiTaxDeductible`, `aiReasoning`, `aiCategorizedAt`, all nullable.
- **routes/email-capture.js** and **routes/customer-account.js** — both save/claim paths (email capture, Google sign-in capture, and the wallet save button) trigger categorization **asynchronously in the background** — the actual save/print action never waits on the AI call. Results get written to the DB whenever they finish; the wallet just won't show a badge until the next page load if it's still processing.
- **views/customer-wallet.ejs** — category badge (purple) and a "Possibly deductible" badge (green, with the AI's one-sentence reasoning as a hover tooltip) on each receipt. Receipts not yet categorized just show no badge — no broken UI.
- **Incentive messaging added at the two moments that matter**: the save-receipt modal subtitle now says what the customer gets in return for saving, and the account signup page states it up front too.

**Setup required:** an `ANTHROPIC_API_KEY` from console.anthropic.com in `.env`. Without it, categorization silently no-ops — saves and the rest of the product work completely normally, receipts just won't have category badges.

**Tested without a live API key** (none available in this build environment) by isolating and testing the actual parsing/validation logic against realistic and adversarial model outputs: a normal valid response, a hallucinated category outside the fixed list (correctly falls back to "Other"), and critically — **a response wrapped in markdown code fences, which failed on the first test pass**. That's a real, common LLM quirk (models add ` ```json ` fences even when explicitly told not to) — it would have silently dropped categorization for some real fraction of receipts. Fixed by stripping fences defensively before parsing, then re-verified the fix resolves it. This is the kind of bug that visual/structural review alone wouldn't have caught.

## Customer login/signup pages (previously missing — now built and tested)

Checking the customer wallet surfaced a real gap: `POST /account/login` and `POST /account/signup` existed, but there was no actual page to land on and submit them — the receipt page's "Save to My ReceiptTap Account" button redirected to `/account/login`, which would have 404'd.

- **routes/customer-account.js** — added `GET /account/login` and `GET /account/signup` (render the actual pages), plus `POST /account/google` — a unified Google Sign-In endpoint used by both pages. If the Google account's email has no `Customer` record yet, one is created automatically, so Google sign-in doubles as signup with no separate flow needed.
- **views/account-login.ejs** / **views/account-signup.ejs** — email/password form + "Sign in with Google" button (Google Identity Services, same pattern as the receipt-save modal), styled to match the merchant login/signup pages.

**Bug caught during testing, not just visual review:** ran the actual login form against a live mock server with real browser automation. First test attempt gave a false negative — clicking a `text=Log In` selector matched the page's `<h1>Log in to ReceipTap</h1>` heading instead of the submit button (case-insensitive substring matching), so nothing actually submitted. Fixed the test to target the button precisely, then confirmed the real behavior: wrong password shows "Invalid email or password" inline, correct password redirects to the intended page (`?redirect=` param honored). This is called out because it's a good example of why interaction needs testing with a real click path, not just checking that markup exists — a convincing-looking page can still be silently broken.

## ReceipTap branding header (persistent nav across the merchant dashboard)

- **public/images/receiptap-logo.png** — the actual ReceipTap logo asset, served statically.
- **server.js** — added `express.static` middleware to serve the `public/` folder.
- **views/partials/dashboard-header.ejs** — shared header partial: logo (links back to the receipts hub), nav links (Receipts, Customer Emails, POS Setup, Receipt Settings), and a Log Out button (posts to the existing `/logout` route). Takes an `activeNav` local to highlight the current page.
- **Included at the top of all 7 dashboard pages**: `receipts-hub.ejs`, `merchant-receipts.ejs`, `merchant-expenses.ejs`, `theme-settings.ejs`, `pos-setup.ejs`, `device-assignment.ejs`, `customer-emails.ejs` — each passing its own `activeNav` so the current section highlights correctly.

**Tested with a real browser (Playwright), not just static rendering** — confirmed the logo displays correctly, nav spacing/highlighting works, and the header doesn't clash with page-specific content (checked both the receipts-hub table view and the settings page's layout picker). Note: static preview tools like wkhtmltoimage don't support modern flexbox `gap` and will show cramped nav spacing — this is a limitation of that specific preview tool, not the actual site; real browsers (what your merchants will use) render it correctly.

## Receipt layout picker (multiple designs + live preview)

Merchants now choose a structural layout, then their existing branding (colors, logo, header/footer text) applies on top of whichever one they pick — not just color customization on a single fixed design.

- **prisma/schema.prisma** — `ReceiptTheme.layoutId` (`"classic"` | `"modern"` | `"minimal"`, defaults to `"classic"`).
- **views/receipt-layouts/*.ejs** — three self-contained layout partials:
  - `classic.ejs` — the original centered card design (unchanged visually — verified identical to the pre-refactor version)
  - `modern.ejs` — bold accent-colored header band, card-style line items, large emphasized total
  - `minimal.ejs` — monospace, thermal-paper receipt look, no color, dashed separators
- **views/receipt.ejs** — refactored into a slim shell: shared CSS (buttons, Google review card, save modal, print styles) + `<%- include('receipt-layouts/' + theme.layoutId, ...) %>` for the structural part. The action buttons (wallet, save, expense, review, warranty, loyalty) stay visually consistent across all three layouts, sitting below whichever card design was chosen.
- **routes/theme-settings.js** — `GET /dashboard/settings/receipt/preview/:layoutId` renders a live, real preview using the exact same shell + partials real customers see (with sample transaction data), and accepts `?primaryColor=&accentColor=&headerText=` query overrides so the picker can reflect in-progress edits before saving.
- **views/theme-settings.ejs** — the picker: three scaled-down `<iframe>` thumbnails pointing at the live preview route, click-to-select (verified with real browser automation — clicking updates both the visual selection border and the hidden form field that gets submitted), and a debounced live-refresh so the thumbnails update as the merchant edits colors/header text, before they've even saved.

**Verified:** all three layouts render correctly with identical sample data (screenshots compared side by side — genuinely distinct visual designs, not just color swaps), the classic layout is pixel-identical to the pre-refactor original (no regression), and the picker's click-to-select was tested with actual browser clicks, not just visual inspection.

## Save Receipt (PDF/Files) gated behind email capture

Customers get a "Save Receipt (PDF / Files)" button on their receipt. Clicking it opens a modal requiring an email (or Google Sign-In) before the save actually happens — this is what lets both you and the merchant build an email list from real foot traffic.

- **routes/email-capture.js** — `POST /receipt/:id/capture-email` (plain email, no password — a quick capture gate, not a full account) and `POST /receipt/:id/capture-email-google` (verifies a real Google ID token server-side via `google-auth-library`, never trusts a client-claimed email). Both link the transaction to a `Customer` record — same mechanism the wallet feature already uses, so a captured email also gets that customer into their own wallet automatically.
- **`GET /dashboard/customer-emails`** (same file) — the merchant's own view of every email captured from taps at THEIR store, with visit counts, plus CSV export. No separate table — it's just customers linked to that merchant's transactions, so it can't drift out of sync.
- **views/receipt.ejs** — the button, the modal (email input + Google Sign-In button via Google Identity Services), and print-optimized CSS (`@media print` hides all the buttons/modal so the saved PDF is just the clean receipt). "Save" actually triggers the browser's native print dialog after the email step succeeds — on both iOS and Android this offers "Save as PDF" / "Save to Files" as real destinations, no PDF library needed.
- **views/customer-emails.ejs** — merchant's list view.
- **prisma/schema.prisma** — `Customer` already has `googleId` and `name`, populated on the Google Sign-In path.

**Setup required:** register a Google Cloud project → OAuth consent screen → Web application credentials → add your real domain (and `localhost` for dev) as Authorized JavaScript origins → put the client ID in `GOOGLE_CLIENT_ID` in `.env`. Without it, the email-only path still works fine; the Google button just won't render.

**Tested with a real headless browser (not just static rendering):** clicking "Save Receipt" opens the modal, "Cancel" closes it cleanly, and submitting with an empty email shows the validation error inline — all confirmed via actual clicks, not just visual inspection.

## Merchant receipt settings (Google review link + branding)

- **routes/theme-settings.js** — `GET`/`POST /dashboard/settings/receipt`. Reads and writes the merchant's `ReceiptTheme` row (upsert — works whether they've customized before or not).
- **views/theme-settings.ejs** — the actual settings form: logo URL, primary/accent colors, header/footer text, and the Google review link with an inline explanation of where to find it (Google Business Profile → "Ask for reviews," or business.google.com). Toggles for whether each optional receipt section shows up.
- **Validation, tested with real edge cases:** if "Show Rate us on Google" is checked, the URL must be `https://` and match a real Google review domain (`google.com`, `g.page`, or `goo.gl`) — catches typos, non-Google links, and `http://` before they'd ever reach a customer. Verified against 7 cases including valid Google Business links, non-URLs, and a fake lookalike domain — all passed.
- This is what feeds `theme.googleReviewUrl` on the receipt page — once saved here, the "Rate us on Google" card on every receipt links straight to it.

## The full lifecycle, tying every piece together

1. Merchant signs up (`/signup`) → connects Square (`/oauth/square/connect`) → assigns pucks to registers (`/dashboard/pos-setup`)
2. You generate a puck batch (`scripts/generate-batch.js`) → send manifest to NFC supplier → pucks ship pre-encoded and locked
3. Merchant unboxes, taps or scans QR → `/claim/:puckId` → enters claim code → puck linked to their account
4. Customer buys something → Square fires a webhook → `/webhooks/pos/square` saves the `Transaction` and updates the puck
5. Customer taps the puck → `/r/:puckId` → sees their live receipt → optionally saves it to their own wallet or (if they're a merchant buying elsewhere) as a business expense
6. Merchant reviews everything in `/dashboard/receipts-hub` — sales issued and expenses received, side by side

