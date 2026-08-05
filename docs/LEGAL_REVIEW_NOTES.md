# Legal Review Notes

Every `[[REVIEW: ...]]` marker currently live on a published legal page, in
one place, for handoff to a lawyer. Source of truth is the marker text
itself, rendered inline on the page — this file is a summary index of it,
not a replacement for reading the page.

Covers: **Privacy Policy** (`/legal/privacy`, rendered from
`views/partials/legal-privacy-content.ejs`, version `2026-08-05.2`) and
**Terms of Service** (`/legal/terms`, rendered from
`views/partials/legal-terms-content.ejs`, version `2026-08-05.2`).

The Data Processing Agreement (`/legal/dpa`) has no drafted content yet —
it still renders the "coming soon" stub, so there is nothing to review on
that page yet.

---

## LAUNCH BLOCKER — checkout screen doesn't disclose terms before payment

**Where:** `views/billing.ejs`, the "Not started" state (the screen shown
before a merchant clicks "Start free trial"), and the Stripe Checkout
session it hands off to (`services/stripeService.js` `createCheckoutSession`).

**Issue:** the Terms of Service's "Subscription and billing" section
promises that the trial length, exact amount, billing interval, and plan
are "shown to you on the signup screen before you enter your card." Audited
against the actual code, and that's only partly true:

- ✅ Trial length appears, but only baked into the button text ("Start
  30-day free trial") — not stated as a standalone disclosure.
- ⚠️ Price appears ("$49.99 / month" at `views/billing.ejs:124`), but it's a
  **hardcoded string in the template**, not fetched from Stripe or any DB
  field — if the Stripe Price is ever changed, this goes stale silently and
  the page starts showing a wrong price.
- ❌ Currency is never labeled anywhere on this screen — just a bare `$`.
- ❌ The exact date of first charge is not shown anywhere before the card
  is submitted — it's only computed and displayed *after* a subscription
  already exists.

After this screen, the merchant is sent to Stripe's own hosted Checkout
page, which is Stripe's UI, not this codebase's — whether it separately
discloses an exact first-charge date or currency there could not be
confirmed by reading this repo.

**Why this is a blocker, not a routine `[[REVIEW]]`:** both the Ontario
Consumer Protection Act and US auto-renewal laws require clear disclosure
of price, renewal terms, and cancellation method *before* a purchase is
completed. A Terms page reachable by a link satisfies the "in writing
somewhere" requirement, not the "shown before you pay" requirement — those
are two different legal obligations, and right now only the first one is
met.

**Needed before launch:**
1. Replace the hardcoded price in `views/billing.ejs` with a real value —
   ideally fetched from the Stripe Price object referenced by
   `STRIPE_PRICE_ID`, not a second hand-maintained copy of the number.
2. Add an explicit currency label next to the price.
3. Compute and display the exact first-charge date on this same screen,
   before the "Start free trial" button — not just after subscribing.
4. Confirm what Stripe's own hosted Checkout page shows once configured
   with the real Price/trial settings, and make sure it doesn't contradict
   whatever ends up on our own pre-checkout screen.

This was not fixed as part of drafting the Terms — flagging only, per
instruction.

---

## 1. Registered address is missing

**Where:** intro paragraph and the contact box, both near the top/bottom of
the Privacy Policy.

**Issue:** the entity's registered address was never supplied. The page
currently renders the literal placeholder `[[REVIEW: address pending]]` in
both spots.

**Needed:** the exact registered address for J.A.C. GLOBAL APPROACH LTD.,
from the Articles of Incorporation. Fill it into `PRIVACY_ENTITY` in
`routes/legal.js` (`registeredAddress: null` → the real string) once
available; the page will pick it up automatically.

---

## 2. Retention windows are policy, not live enforcement

**Where:** "How long we keep your data" (shopper section) and "If you
close your account" (merchant section).

**Issue:** the page states ReceipTap's policy is to delete shopper data
after 24 months and closed-merchant data after 90 days (the real numbers
from `config/retention.js`). But automated purging is currently gated
behind `RETENTION_PURGE_ENABLED`, which is unset everywhere — all purge
functions in `services/dataRetentionService.js` run in dry-run mode only.
**Nothing is actually being auto-deleted on this schedule today.**

**Needed:** a decision — either (a) turn on live purging before this page
goes out, so the stated policy matches reality, or (b) keep the policy
language as a forward-looking commitment and have a lawyer confirm that's
an acceptable way to state it (vs. describing current manual/ad-hoc
handling instead). This is the single biggest gap between what the page
says and what the system does — do not resolve it by editing the page's
wording alone.

---

## 3. Shopper-initiated global deletion is manual, not self-serve

**Where:** "Getting a copy, deleting your data, or unsubscribing," delete
bullet.

**Issue:** today, a merchant can delete a shopper's data with that specific
business via `/dashboard/customer-emails` (lookup + delete). A shopper
asking ReceipTap directly to erase their data across every business they've
used ReceipTap at is handled by hand, by us, on request — there's no
self-serve "delete everywhere" page yet.

**Needed:** confirm this manual process is acceptable to describe as-is, or
prioritize building a self-serve version before publishing.

---

## 4. No unsubscribe mechanism exists yet

**Where:** "Getting a copy, deleting your data, or unsubscribing,"
unsubscribe bullet.

**Issue:** ReceipTap doesn't send marketing or bulk email today, so there's
no unsubscribe link to point to. The page currently just tells a shopper to
email us and we'll record the request by hand.

**Needed:** confirm that's acceptable for launch, or note this needs
revisiting once/if ReceipTap starts sending any marketing email itself.

---

## 5. Server hosting region unconfirmed

**Where:** "Where your data is stored" (shopper section).

**Issue:** Supabase's region was confirmed from the codebase (AWS
`ca-central-1`, Montreal) and is *not* flagged. Railway's region — where
the application server itself runs — could not be confirmed from the
codebase.

**Needed:** confirm the Railway deployment region and update this
paragraph if the app server itself runs outside Canada.

---

## 6. DPA has no content yet

**Where:** "Our role for your customers' data" (merchant section), links to
`/legal/dpa`.

**Issue:** the Privacy Policy references the Data Processing Agreement as
where the processor relationship is spelled out in detail, but that page is
still the "coming soon" stub.

**Needed:** write the DPA before treating this Privacy Policy as final —
right now the link points to an empty page.

---

## 7. "Shopify" subprocessor leftover

**Where:** merchant "Subprocessors" list.

**Issue:** some account-settings UI still has a leftover "Shopify" option
from earlier development. It's not a working integration — no data is sent
to or received from Shopify. The policy notes this explicitly rather than
silently listing Shopify as a real subprocessor.

**Needed:** either remove the leftover UI option from the product, or
decide to leave the note in the policy permanently if the option stays.

---

## 8. Breach notification timeline unconfirmed

**Where:** "If something goes wrong."

**Issue:** the page commits to notifying affected people and any required
regulator, per Canadian law, but doesn't state a specific timeline or
threshold.

**Needed:** lawyer to confirm the specific notification timeline/thresholds
required under PIPEDA and any applicable provincial law, and whether this
page should state them explicitly.

---

## 9. No mechanism to announce policy changes

**Where:** "Changes to this policy."

**Issue:** the page says the "last updated" date will change when the
policy does, but ReceipTap has no bulk/marketing email sender today, so
there's no way to proactively notify every shopper or merchant of a
material change.

**Needed:** decide on an announcement mechanism (e.g., a dashboard banner
for merchants) before a material change happens, or confirm silent
date-stamp updates are acceptable.

---

## Terms of Service

## 10. Registered address is missing (same gap as the Privacy Policy)

**Where:** intro paragraph and the contact box on the Terms of Service.

**Issue:** same missing registered address as item 1 above — both
documents now read it from the same shared `ENTITY` constant in
`routes/legal.js` (renamed from `PRIVACY_ENTITY`, since it's no longer
Privacy-specific), so this resolves in both places the moment it's filled
in.

**Needed:** same as item 1 — fill in `ENTITY.registeredAddress` in
`routes/legal.js` once the real address is available.

---

## 11. Plan-change and proration mechanics are undefined

**Where:** "Subscription and billing" → "If we offer more than one plan."

**Issue:** the billing system currently supports exactly one hardcoded
Stripe Price (`STRIPE_PRICE_ID`, one env var, no plan field on `Merchant`).
There's no upgrade/downgrade route, and no proration logic anywhere in the
code. The Terms describe the *intended* behavior once multiple plans
exist (how a switch takes effect, how a price difference is handled), but
that's a promise about future behavior, not a description of anything that
runs today.

**Needed:** before a second plan is ever offered, decide and build the
actual mechanics (immediate vs. next-renewal switch, how proration is
calculated), and confirm the code matches what this paragraph promises.

---

## 12. Tax treatment on the subscription price is undetermined

**Where:** "Subscription and billing" → "Taxes."

**Issue:** no tax calculation exists anywhere in the billing code — no
Stripe Tax configuration, no tax line on an invoice preview. Whether the
price shown at signup is meant to include or exclude applicable sales tax
has never been decided.

**Needed:** a decision, and if tax needs to be added, real Stripe Tax
configuration to back it up before this section can state anything
accurate.

---

## 13. Price-increase notice has no delivery mechanism yet

**Where:** "Subscription and billing" → "Price changes."

**Issue:** the Terms commit to a 30-day email notice before any price
increase takes effect on an existing subscriber. Same gap as the Privacy
Policy's "Changes to this policy" section: this app has no bulk/automated
email sender today (Resend is only ever used for password resets). A
price-increase notice would have to be sent by hand today.

**Needed:** build the actual notification mechanism before this commitment
is relied on, or decide on and document an interim manual process.

---

## 14. No refund policy or refund logic exists

**Where:** "Refunds."

**Issue:** grepped the whole codebase — zero refund-related Stripe calls,
zero refund routes, zero refund policy decided. A refund today would have
to be issued by hand, directly in the Stripe Dashboard, one at a time.

**Needed:** decide the actual policy (none, prorated, discretionary,
time-limited, etc.) and replace the placeholder paragraph with it.

---

## 15–18. Hardware (NFC puck) terms — four undecided items

**Where:** "Hardware (NFC pucks)."

**Issue:** the repo establishes what a puck *is* and how it's technically
provisioned (passive, no battery/radio, linked via a claim code, assigned
to a specific register), but establishes nothing about the commercial
terms around it. Four separate open questions, flagged individually rather
than guessed at:

- **15. Ownership** — does a puck become the business's property, or does
  it stay ReceipTap's property for the life of the subscription?
- **16. Condition on cancellation** — does the business keep the puck,
  return it, or something else?
- **17. Replacement terms** — is a replacement for a lost or damaged puck
  free, or chargeable, and at what cost?
- **18. Shipping** — who pays for it, what's the expected delivery time,
  and is international shipping offered?

**Needed:** a real decision on each of the four, to replace the four
`[[REVIEW]]` markers in the Hardware section.

---

## 19. Data-purge automation status (same tension as the Privacy Policy)

**Where:** "Termination."

**Issue:** identical tension to the Privacy Policy's retention sections —
the Terms state the 90-day post-deactivation purge as policy, but
automated purging is gated behind `RETENTION_PURGE_ENABLED`, which is
unset in every environment. Nothing is actually being auto-deleted on this
schedule today.

**Needed:** same as the Privacy Policy's equivalent note — either turn on
live purging so the stated policy matches reality, or have a lawyer
confirm stating it as a forward-looking commitment is acceptable.

---

## Also flagged during fact-finding, resolved on this pass

- `docs/DATA_INVENTORY.md` Gap #8 previously claimed IP addresses were
  "confirmed NOT collected" — that was stale.
  `services/legalAcceptanceService.js` and `services/shopperConsentService.js`
  both capture `req.ip` onto every consent/acceptance audit row. Both are
  now fixed: `DATA_INVENTORY.md` Gap #8 has been corrected to describe the
  actual behavior, and the shopper section's "What we collect, and why"
  list on the Privacy Policy now discloses IP collection at the point a
  consent checkbox is used. No `[[REVIEW]]` marker was needed for this one
  — it was a factual gap with a known answer, not a judgment call.
