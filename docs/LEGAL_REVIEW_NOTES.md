# Legal Review Notes

Every `[[REVIEW: ...]]` marker currently live on a published legal page, in
one place, for handoff to a lawyer. Source of truth is the marker text
itself, rendered inline on the page — this file is a summary index of it,
not a replacement for reading the page.

Covers: **Privacy Policy** (`/legal/privacy`, rendered from
`views/partials/legal-privacy-content.ejs`, version `2026-08-05.2`),
**Terms of Service** (`/legal/terms`, rendered from
`views/partials/legal-terms-content.ejs`, version `2026-08-06.2`), and
**Data Processing Agreement** (`/legal/dpa`, rendered from
`views/partials/legal-dpa-content.ejs`, version `2026-08-06.1`).

---

## LAUNCH BLOCKER — checkout screen doesn't disclose terms before payment

**Where:** `views/billing.ejs`, the "Not started" state (the screen shown
before a merchant clicks "Start free trial"), and the Stripe Checkout
session it hands off to (`services/stripeService.js` `createCheckoutSession`).

**Issue:** the Terms of Service's "Subscription and billing" section
promises that the trial length, exact amount, billing interval, and plan
are "shown to you on the signup screen before you enter your card." Audited
against the actual code, and that was only partly true.

**Status: items 1–4 RESOLVED.** `views/billing.ejs` now shows, before the
"Start 30-day free trial"/"Restart subscription" button:

- The real price and billing interval, fetched live from Stripe
  (`getSubscriptionPrice()` in `services/stripeService.js`, reading the
  `Price` object referenced by `STRIPE_PRICE_ID`) — no more hand-maintained
  hardcoded number that can drift silently from the real Stripe price.
- An explicit currency label (`USD`) next to every price shown on the page,
  not just a bare `$`.
- The exact first-charge date, computed as today + the real `TRIAL_DAYS`
  constant, shown as a standalone sentence ("30-day free trial, then
  $49.99 USD / month starting [date] — cancel anytime before then and pay
  nothing. A card is required to start the trial.") — not just implied by
  the button text, and not only computed after a subscription already
  exists.

What's still open:

4. **Stripe's own hosted Checkout page** is Stripe's UI, not this
   codebase's — whether it separately (and consistently) discloses the
   first-charge date and currency there could not be confirmed by reading
   this repo. Worth a manual check against the real Checkout session once
   convenient.
5. **Shipping charge — RESOLVED for first-time signups.** The $25 USD
   shipping fee is now a real one-time Stripe Checkout line item
   (`services/stripeService.js` `createCheckoutSession`), added alongside
   the recurring subscription price and charged immediately at checkout —
   verified against the real Stripe API that it's uncoupled from the
   trial (the recurring item shows $0 due today, the shipping item shows
   the full $25.00 due today). Disclosed on the pre-payment screen in
   `views/billing.ejs` next to the trial/price disclosure.

6. **Shipping charge on a "Restart subscription" — RESOLVED, no tracking
   built.** The $25 fee is only charged when `merchant.subscriptionStatus
   !== 'CANCELED'` — a merchant restarting after a prior cancellation is
   *not* charged shipping again, since whether they still have their puck
   depends on whether they returned it under the 30-day return window
   (see the $60 replacement fee below), and nothing in this app tracks
   that. **Decision (founder, 2026-08-07):** don't build return tracking
   for this — it's a real feature (a `returnedAt`-style field plus a way
   to mark a puck received back), and this scenario (cancel → return →
   restart) has zero real-world volume so far, no customers yet. The
   conservative default (never charge on restart) stays as the permanent
   behavior; if the rare case of a restarting merchant who returned their
   puck actually comes up, charge the $25 by hand in Stripe that one
   time rather than maintaining tracking infrastructure for it.

7. **The $60 replacement fee — tracking built, charging still manual by
   design.** Founder decision (2026-08-07): build the 30-day-return-window
   tracking so it's visible, but keep the actual $60 charge a manual step
   rather than automating an off-session card charge to a former customer
   weeks after they've cancelled — getting that wrong (e.g. a puck lost in
   transit, not the merchant's fault) risks a charge that feels
   unauthorized to someone no longer actively using the product.

   **What's built:** `Puck.returnDeadlineAt`/`returnedAt`
   (`prisma/schema.prisma`), set by `syncPuckReturnWindows()` in
   `services/stripeService.js` — called from every place
   `Merchant.subscriptionStatus` actually changes (both Stripe webhook
   handlers, the checkout-success sync in `routes/billing.js`, and the
   polling fallback in `middleware/subscriptionGate.js`, since no Stripe
   webhook secret is configured yet and any of these could be the one
   that actually fires). Cancelling starts a 30-day deadline on every
   puck the merchant currently has; restarting before returning it clears
   the deadline. `/admin/pucks` shows every puck currently under a return
   obligation, flags ones past their deadline as "$60 fee applies," and
   has a "Mark as returned" action.

   **Still not built, deliberately:** prepaid-return-label emailing (needs
   a real shipping-carrier API integration, e.g. Shippo/EasyPost) and the
   actual $60 charge itself — a human has to notice an overdue row on
   `/admin/pucks` and charge it by hand in the Stripe Dashboard.

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

## 6. DPA has no content yet — RESOLVED

**Where:** "Our role for your customers' data" (merchant section), links to
`/legal/dpa`.

**Status: RESOLVED**, as of `DPA.version` `2026-08-06.1`. The DPA is now
drafted (`views/partials/legal-dpa-content.ejs`), covering roles, scope,
security measures, subprocessors, transfers, breach notification, deletion,
audit rights, and liability. It has its own set of open `[[REVIEW: ...]]`
items — see the new "Data Processing Agreement" section below, after item
20 — most of which restate gaps already listed above (address, retention/
purge-live-status, transfer region, breach timeline) because the same
underlying facts are now stated in a third document, plus two genuinely new
open questions (audit rights, whether the Terms' liability cap extends to
DPA claims).

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

## 14. Refund policy — RESOLVED (policy), two gaps remain

**Where:** "Refunds."

**Status: RESOLVED**, as of `TERMS.version` `2026-08-07.1`. Founder
decision: no refunds after the trial, including for partial billing
periods — downgrading or reduced usage doesn't generate a credit either.
Two exceptions: a discretionary refund for extended service failure that's
our fault, and a full refund for a genuine duplicate/erroneous charge.
Hardware fees (shipping, replacement) are called out as separate from
subscription fees and not governed by this section — see the Hardware
section instead. A closing sentence preserves any right that can't be
waived under applicable law.

**Gap 1 — operational, not policy:** there's still zero refund-related
Stripe calls or refund routes in the codebase, so even the two exceptions
above are issued by hand, one at a time, in the Stripe Dashboard. Flagged
as an inline operational note on the page itself, not a `[[REVIEW]]`
marker, since the policy question is what's resolved here.

**Gap 2 — Stripe Customer Portal cancellation path unconfirmed:** the
Billing page's "Manage in Stripe" button sends a merchant to Stripe's own
Customer Portal, which also lets them cancel from there. Whether Stripe is
configured (in the Stripe Dashboard, not this codebase) to cancel
immediately or at period-end for that path hasn't been confirmed — flagged
inline as a `[[REVIEW]]` marker rather than assumed to match either of the
two paths described in the page (see item 24 below for why those two
differ from each other in the first place).

---

## 15–17. Hardware (NFC puck) terms — RESOLVED (ownership, return, replacement)

**Where:** "Hardware (NFC pucks)."

**Status: RESOLVED**, as of `TERMS.version` `2026-08-06.1`. The founder made
the following business decisions, now written into the Hardware section:

- **15. Ownership** — the puck stays the property of J.A.C. GLOBAL
  APPROACH LTD at all times; it's provided for use with the service, and
  ownership never transfers to the merchant.
- **16. Condition on cancellation** — on cancellation or termination, a
  prepaid return label is emailed to the address on file, and the
  merchant has **30 days** from that email to return every puck on the
  account.
- **17. Replacement terms** — a puck not returned within that 30-day
  window, or damaged/lost while the subscription is active, is replaced
  at **$60 USD per unit**, charged to the payment method on file. A puck
  that fails on its own (not the merchant's fault) is replaced free.

**Note for the lawyer reviewing this:** the **$60 USD figure** and the
**30-day return window** are business decisions made directly by the
founder, not legal-research conclusions — worth confirming they're
reasonable and enforceable (e.g., that $60 is defensible as a genuine
pre-estimate of replacement cost rather than a penalty) rather than
re-deriving them from scratch.

## 18. Shipping — RESOLVED

**Where:** "Hardware (NFC pucks)" → "Shipping."

**Status: RESOLVED**, as of `TERMS.version` `2026-08-06.2`. The founder
decided: the merchant pays a flat **$25 USD** shipping charge per
shipment, shipping is currently **Canada-only**, and delivery is expected
within **30 days** of a puck being sent.

**Note for the lawyer reviewing this**, same as items 15–17: the $25
figure, the 30-day delivery window, and the Canada-only limitation are
founder business decisions, not legal-research conclusions. Worth
flagging separately: **Canada-only shipping sits oddly next to the rest
of these Terms**, which don't otherwise restrict who can sign up by
country — worth confirming that's an intentional, temporary limitation
(and deciding how a non-Canadian merchant who signs up anyway should be
handled) rather than an oversight.

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

## 20. Some merchants may need a separately signed DPA, not just the click-through

**Where:** not an inline `[[REVIEW]]` marker on any page — a process note,
since the click-through DPA (incorporated by reference into the Terms as of
`TERMS.version` `2026-08-05.3`, see item 6 above and the "Data Processing
Agreement" subsection of `views/partials/legal-terms-content.ejs`) is a
one-size-fits-all mechanism, and not every prospective customer will accept
that as-is.

**Issue:** some merchants — healthcare providers, financial-services
businesses, and larger companies going through their own procurement or
vendor-security review — routinely require a DPA to be separately
negotiated and signed (or at least countersigned) before they'll agree to
use a vendor, rather than accepting a click-through version bundled into a
Terms-of-Service checkbox. There's no code path for this today: signup
only supports the single-checkbox flow from Part B of this task, which
records agreement to the click-through DPA and nothing else.

**Needed:** treat the click-through DPA as the **default** path for
everyone, and the countersigned-PDF DPA as an **exception path** for
accounts that ask for one — handled manually (a real negotiated document,
signed outside this app) rather than by building signup-flow support for
it now. Worth deciding, before it comes up with a real prospective
customer: who at the business fields that request, what the fallback
document looks like, and whether a merchant with a separately-signed DPA
should still have their `LegalAcceptance` DPA row written (documenting
that the click-through was superseded) or handled entirely outside this
table.

---

## Data Processing Agreement

The DPA (`/legal/dpa`) was drafted as part of the same pass that produced
this update — see item 6 above. It reuses the same `ENTITY` constant as
Terms/Privacy, so items 1/10 (registered address) resolve there too once
filled in. Its subprocessor list must be kept in sync with the Privacy
Policy's merchant "Subprocessors" section by hand — they describe the same
underlying facts to two different audiences and there's no shared template
enforcing that today.

**Restated gaps** (same underlying fact as an item above, now also stated
on the DPA page — resolving the item above resolves this too, nothing
separate to track):

- Registered address — same as item 1/10.
- Retention windows enforced in code but not live in production
  (`RETENTION_PURGE_ENABLED` unset) — same as item 2/19.
- Application server (Railway) region unconfirmed — same as item 5.
- Breach notification timeline unconfirmed under PIPEDA — same as item 8.

## 21. Security-measures language is deliberately conservative

**Where:** "Security measures."

**Issue:** the page states only what's actually implemented and confirmed
today (hashed passwords, cards never touching our servers, HTTPS, session
auth) — it does not claim a formal certification (SOC 2, ISO 27001) or an
encryption-at-rest guarantee from Supabase or our hosting provider, since
neither has been independently confirmed.

**Needed:** confirm what Supabase and the hosting provider actually
guarantee (encryption at rest, in particular) before strengthening this
language — don't assert more than is currently known to be true.

---

## 22. Audit rights not decided

**Where:** "Demonstrating compliance."

**Issue:** no audit-rights clause has been decided. A typical DPA gives the
controller (the merchant) some right to request information demonstrating
compliance, sometimes including a right to audit — directly or via a third
party — with reasonable notice. This is currently a small operation without
a dedicated compliance team.

**Needed:** decide what's realistic to commit to (e.g. a written
attestation on request, rather than an on-site audit right) and replace the
placeholder paragraph with it.

---

## 23. Whether the Terms' liability cap extends to DPA claims

**Where:** "Liability."

**Issue:** the Terms of Service cap total liability at the subscription
fees paid in the prior 12 months. Whether that same cap should apply to
claims arising specifically from the DPA, or whether data-protection claims
need a separate (often higher, or uncapped) limit, as is common in DPAs
generally, hasn't been decided.

**Needed:** a legal decision on whether to carve out a different liability
limit for DPA/data-protection claims, then replace the placeholder
paragraph with the answer.

---

## 24. Three cancellation paths, two different behaviors — code risk, not just a wording gap

**Where:** not a `[[REVIEW]]` marker on any page — a cross-cutting
consistency issue found while drafting the Refunds section (item 14
above), since accurately describing "what happens when you cancel"
required checking what the code actually does.

**Issue:** there are three distinct ways a merchant's subscription stops,
and they behave differently:

1. **"Cancel Subscription"** (Billing page → retention-discount modal) —
   `cancelSubscriptionAtPeriodEnd()` in `services/stripeService.js`, which
   calls `stripe.subscriptions.update(id, { cancel_at_period_end: true })`.
   Access continues through the end of the already-paid period.
2. **"Deactivate account"** (Account Settings) —
   `routes/account-settings.js`'s `/dashboard/settings/account/deactivate`,
   which calls `stripe.subscriptions.cancel(id)` — Stripe's **immediate**
   cancellation, no period-end grace. In the same request, it also sets
   `isActive: false` and `deactivatedAt: new Date()`, which starts the
   `DEACTIVATED_MERCHANT_PURGE_DAYS` data-purge clock
   (`config/retention.js`), and destroys the session immediately, logging
   the merchant out on the spot.
3. **Stripe's own Customer Portal** ("Manage in Stripe") — behavior is a
   Stripe Dashboard setting, not confirmed from this codebase. See item 14,
   Gap 2, above.

**Why this is a risk beyond just wording it accurately (which the Refunds
section now does):** a merchant who wants to stop paying but assumes
"deactivate" is just a more thorough version of "cancel" gets a materially
different outcome — losing access *today* instead of at their paid
period's end, with no separate confirmation step calling that out, and
their data-deletion clock silently starts in the same click. That's a UX
and disclosure risk independent of what the Terms say: the Account
Settings deactivate button doesn't warn a merchant that it behaves
differently from the Billing page's cancel button, or that it starts data
deletion.

**Needed:** decide whether this divergence is intentional (deactivation is
meant to be more final than cancellation) or accidental (an oversight from
building the two flows separately at different times). If intentional,
add an explicit warning on the "Deactivate account" button/confirmation
about the immediate-access-loss and data-purge-clock consequences, so a
merchant can't trigger it by mistake thinking it's equivalent to
cancelling. If accidental, decide whether "Deactivate account" should
instead cancel at period-end like the Billing page does, and only start
the purge clock once the paid period actually ends. Either way, this
should be reconciled in the product (button copy, confirmation flow, or
the underlying Stripe call), not left as something only the Terms page
explains correctly.

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
