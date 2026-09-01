# Legal Review Notes

Every `[[REVIEW: ...]]` marker currently live on a published legal page, in
one place, for handoff to a lawyer. Source of truth is the marker text
itself, rendered inline on the page — this file is a summary index of it,
not a replacement for reading the page.

Covers: **Privacy Policy** (`/legal/privacy`, rendered from
`views/partials/legal-privacy-content.ejs`, version `2026-08-05.2`),
**Terms of Service** (`/legal/terms`, rendered from
`views/partials/legal-terms-content.ejs`, version `2026-08-06.2`),
**Data Processing Agreement** (`/legal/dpa`, rendered from
`views/partials/legal-dpa-content.ejs`, version `2026-08-06.1`), **Wallet
Terms of Service** (`/legal/wallet-terms`, rendered from
`views/partials/legal-shopper-terms-content.ejs`, version `2026-08-19.1`),
and **Wallet Privacy Policy** (`/legal/wallet-privacy`, rendered from
`views/partials/legal-shopper-privacy-content.ejs`, version `2026-08-19.1`)
— the last two are the separate pair for an individual wallet-holder
account (`views/account-login.ejs`, `account-signup.ejs`,
`customer-settings.ejs`), distinct from the merchant/business Terms and
Privacy Policy above. See "Wallet Terms of Service / Wallet Privacy
Policy" near the end of this file for their open items.

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

## 1. Registered address — RESOLVED

**Where:** intro paragraph and the contact box, both near the top/bottom of
the Privacy Policy.

**Status: RESOLVED**, as of `PRIVACY.version` `2026-09-01.1`. Founder
supplied the registered address (2026-09-01): 2150 Winston Park Drive,
Unit 203, Oakville, Ontario, L6H 5V1, Canada. Filled into
`ENTITY.registeredAddress` in `routes/legal.js`, which every document
below reads from — resolves items 1 and 10 in one place, plus the
"Restated gaps" copy on the DPA. Every document that shows the address
(Terms, Privacy, DPA, Wallet Terms, Wallet Privacy) had its version bumped
in the same change, since a merchant/shopper who already accepted the old
`[[REVIEW: address pending]]` wording agreed to different text than what's
live now — this is what sends every existing merchant through
`/legal/reaccept` on their next dashboard visit.

**Still worth confirming:** this address matches what's on file in the
Articles of Incorporation, since that's the authoritative source for a
"registered address," not just wherever the business currently operates
from.

---

## 2. Retention windows are policy, not live enforcement — RESOLVED (wording)

**Where:** "How long we keep your data" (shopper section) and "If you
close your account" (merchant section).

**Status: RESOLVED**, as of `PRIVACY.version` `2026-09-01.3`. Founder
decision (2026-09-01): option (b) — keep the retention windows (7 years
for shopper data, matching `SHOPPER_RECEIPT_MONTHS`; 90 days for a closed
merchant account, matching `DEACTIVATED_MERCHANT_PURGE_DAYS`) stated as
policy and commitment, not as something already happening automatically.
Each paragraph now says the automated system is built and being finalized
before being switched on, and points to a real contact
(`entity.contactEmail`) for anyone who wants something deleted sooner.
Same fix applied to the matching paragraphs in the Terms of Service, the
DPA, and the Wallet Privacy Policy (item 19 below, and the DPA's own
restated-gaps line).

**Still open:** turning on live purging (option (a)) is a separate,
future task — `RETENTION_PURGE_ENABLED` should stay unset until someone
has watched `PurgeLog` output for a while in a safe environment first,
per `CLAUDE.md`'s existing "Not done yet" note on this. This wording fix
doesn't require that to happen first; it just stops the page overstating
what's live today.

---

## 3. Shopper-initiated global deletion is manual, not self-serve — RESOLVED

**Where:** "Getting a copy, deleting your data, or unsubscribing," delete
bullet.

**Status: RESOLVED**, founder decision (2026-09-01): keep this manual for
now — email-us-and-we'll-handle-it is an acceptable, defensible answer at
this stage of the business. `deleteShopperEverywhere()`
(`services/dataRetentionService.js`) already exists and is tested for
when this needs to be run by hand. The page's existing wording (asking a
business directly, or emailing `entity.contactEmail`) already describes
this accurately — no copy change was needed, this item was purely a
decision to confirm.

**Revisit when:** volume makes the manual process genuinely burdensome, or
a specific request makes the turnaround time itself a problem worth
solving with a real self-serve page.

---

## 4. No unsubscribe mechanism exists yet

**Where:** "Getting a copy, deleting your data, or unsubscribing,"
unsubscribe bullet.

**Bug found and fixed separately (2026-09-01), as of `PRIVACY.version`
`2026-09-01.4`:** this bullet's entire text used to live inside a
`[[REVIEW: ...]]` marker, which `views/legal-document.ejs`'s `strip()`
helper hides from real visitors in production — so the live page showed
the bullet's bold label with nothing after it, for anyone who actually
read this section. Replaced with the same content as real customer-facing
copy. Worth a quick pass over the other four documents' review markers to
check none of them are the *only* content of their bullet/paragraph the
same way this one was.

**Issue (still open):** ReceipTap doesn't send marketing or bulk email
today, so there's no unsubscribe link to point to — the page now
correctly says a shopper emails us and we record the request by hand.

**Needed:** confirm that's acceptable for launch, or note this needs
revisiting once/if ReceipTap starts sending any marketing email itself.

---

## 5. Server hosting region — RESOLVED (region confirmed, one new gap found)

**Where:** "Where your data is stored" (shopper section), and the mirror
sections on the Wallet Privacy Policy and DPA.

**Status: RESOLVED**, as of `PRIVACY`/`DPA`/`SHOPPER_PRIVACY` version
`2026-09-01.2`. Checked directly in the Railway dashboard (2026-09-01):
the `receiptap-backend` service runs in **US West**, serving
www.receiptap.com. All three documents now say so explicitly, distinct
from Supabase (Montreal) — the previous wording said "stored in Canada"
with three narrow named exceptions (Google/Anthropic/Resend), which
understated things: the application server itself, not just those three
features, processes every request outside Canada, continuously, not
briefly.

**New gap found in the process:** Railway wasn't in either subprocessor
list (Privacy Policy or DPA) at all, despite being the provider that
hosts and runs the entire application. Added to both.

**Still open:** whether an additional cross-border transfer safeguard
(e.g. standard contractual clauses) is legally required now that this is
disclosed as continuous processing, not just an occasional third-party
touch — left as a `[[REVIEW]]` marker on all three documents, a lawyer
question, not a factual one.

**Also worth knowing, found while checking this:** the Railway project is
**live and actively deployed** at www.receiptap.com, auto-deploying on
every push to `main` — `CLAUDE.md`'s "Not deployed yet... just not hosted
anywhere real yet" is stale. Worth updating that file, and worth knowing
that every legal-page edit made from here on is going live immediately on
push, not sitting in a staging environment first.

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

## 7. "Shopify" isn't dead code — real integration planned

**Where:** merchant "Subprocessors" list.

**Status:** founder confirmed (2026-08-07) a real Shopify POS integration
is planned soon — `Merchant.shopifyShopDomain`/`shopifyAccessToken`, the
`else if (merchant.shopifyShopDomain)` display branch in
`views/account-settings.ejs`, and the Shopify references in the admin
panel and `routes/analytics.js`'s POS labels are **not** leftover cruft to
remove; they're already-built groundwork for that integration
(`shopifyAccessToken` currently just never gets set, since there's no
`routes/oauth-shopify.js` or "Connect Shopify" button on
`views/pos-setup.ejs` yet — that's the actual remaining work). Do not
delete these fields/branches.

**Needed on the Privacy Policy page:** the disclosure currently says
Shopify "is not a working integration today, and no data is sent to or
received from Shopify" — true today, but this note needs to be revisited
(most likely removed, with Shopify added as a real subprocessor in the
list above it) once the integration actually ships, not before.

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

## 10. Registered address — RESOLVED (same fix as item 1)

**Where:** intro paragraph and the contact box on the Terms of Service.

**Status: RESOLVED**, as of `TERMS.version` `2026-09-01.1` — see item 1
above. Both documents read the same shared `ENTITY` constant in
`routes/legal.js`, so the one fill-in resolved both.

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

## 12. Tax treatment on the subscription price — RESOLVED (policy), no Stripe Tax built

**Where:** "Subscription and billing" → "Taxes."

**Status: RESOLVED**, founder decision (2026-09-01): the price shown at
signup is tax-inclusive — nothing is added at checkout. No Stripe Tax
configuration or billing-code change was needed for this. Revisit if/when
revenue crosses a threshold that requires charging tax separately in a
given jurisdiction; that would be a real, separate build (Stripe Tax
config plus a tax line in the billing flow), not just a wording change.

**Render bug found and fixed separately (2026-09-01):** this section's
entire `[[REVIEW: ...]]` marker was its only content, which `strip()`
hides in production — the live "Taxes" heading had nothing under it
before either fix landed. Now carries the real decision above
(`TERMS.version` `2026-09-01.3`), so this item is fully closed rather
than just visually patched.

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

## 19. Data-purge automation status — RESOLVED (same fix as item 2)

**Where:** "Termination."

**Status: RESOLVED**, as of `TERMS.version` `2026-09-01.2` — see item 2
above. Same wording fix: the 90-day post-deactivation purge is now stated
as policy/commitment, with a real contact for anyone who wants it done
sooner, rather than implying it already runs automatically.

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

- Registered address — RESOLVED, same as item 1/10.
- Retention windows enforced in code but not live in production
  (`RETENTION_PURGE_ENABLED` unset) — RESOLVED (wording), same as item
  2/19.
- Application server (Railway) region — RESOLVED, same as item 5.
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

**Render bug found and fixed separately (2026-09-01):** same class of bug
as item 12 — this section's `[[REVIEW: ...]]` marker was its only
content, so the live "Demonstrating compliance" heading had nothing under
it. Patched with honest, non-committal copy (`DPA.version` `2026-09-01.4`)
pointing to a real contact; the actual audit-rights decision above is
still open.

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

**Render bug found and fixed separately (2026-09-01):** same class of bug
as items 12 and 22 — the live "Liability" heading had nothing under it.
Patched with honest, non-committal copy (`DPA.version` `2026-09-01.4`)
restating the Terms' 12-month cap and noting the DPA-specific question is
still open; the actual legal decision above still needs answering.

---

## 24. Three cancellation paths, two different behaviors — RESOLVED (warned), one path still unconfirmed

**Where:** not a `[[REVIEW]]` marker on any page — a cross-cutting
consistency issue found while drafting the Refunds section (item 14
above), since accurately describing "what happens when you cancel"
required checking what the code actually does.

**Status: RESOLVED for paths 1 and 2** (2026-08-07). Founder decision: the
divergence is intentional — "Deactivate account" is meant to be more final
than "Cancel Subscription," not an oversight — so the fix was a clear
warning, not changing the behavior. `views/account-settings.ejs` now has a
"Danger zone" section with a "Deactivate account" button (previously,
there was no UI trigger for this route at all — see the note below) that
opens a confirmation modal stating, plainly: the subscription is cancelled
*right now* (shown only when a subscription is actually active), the
merchant is logged out immediately with no self-serve way back in, and
account data is permanently deleted after the real
`DEACTIVATED_MERCHANT_PURGE_DAYS` window (read from `config/retention.js`,
not hardcoded). It also points to "Cancel Subscription" on the Billing
page as the right choice for someone who just wants to stop paying.

**Bonus finding while building this:** `/dashboard/settings/account/deactivate`
had **no UI entry point anywhere** before this fix — the route existed and
worked, but no button or form in any view called it. It's also, in
practice, **not reversible by the merchant at all**: `routes/auth.js`
blocks login the instant `isActive` is false, and per the schema comment
on `Merchant.deactivatedAt`, there's no reactivation flow anywhere in the
app — only a founder editing the database by hand could undo it. The
route's own comment previously claimed this "should be reversible," which
was inaccurate; fixed to describe the real behavior.

**Still open — path 3:** Stripe's own Customer Portal cancellation
behavior remains unconfirmed (see item 14, Gap 2) — a Stripe Dashboard
setting, not visible in this codebase.

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

## Wallet Terms of Service / Wallet Privacy Policy

New as of `2026-08-19.1`. Written for an individual with a ReceipTap
Wallet account, separate from the merchant/business Terms and Privacy
Policy above — a wallet account isn't a business and doesn't sign the DPA
(there's no controller/processor relationship for an individual holder,
so no wallet-side DPA exists). Open items:

**25. No dollar figure for the liability cap — RESOLVED.**
**Where:** Wallet Terms, "Limitation of liability."
**Status: RESOLVED**, founder decision (2026-09-01): no additional dollar
cap for the free Wallet account — liability is limited to whatever
applicable law itself provides, unlike the merchant Terms' 12-month cap.
Live as of `SHOPPER_TERMS.version` `2026-09-01.2`. Still worth a lawyer's
sanity check on the exact clause wording before treating it as final,
same as any other liability clause — that's a wording-quality check now,
not an open policy question.
**Render bug found and fixed in the same pass (2026-09-01):** the old
placeholder was a `[[REVIEW: ...]]` marker inline mid-sentence ("...is
capped at [marker]."), so the live sentence read "...is capped at ." with
a dangling period once `strip()` removed it in production — fixed as part
of writing the real decision above, not as a separate step.

**26. No re-acceptance interstitial for wallet accounts.**
**Where:** Wallet Terms, "Changes to these Terms."
**Issue:** merchants are redirected to `/legal/reaccept` when a document
they've accepted goes stale (`middleware/legalReacceptance.js`,
`services/legalAcceptanceService.js`); no equivalent exists for wallet
accounts, which also have no `LegalAcceptance` rows written at all today
(signup uses passive "By continuing..." text, not a checkbox — see
`views/account-signup.ejs`).
**Needed:** decide whether a wallet-side acceptance/re-acceptance
mechanism should be built, or whether passive linking is acceptable for
this product.

**27. Scanned receipt photo storage — RESOLVED, stale when written.**
**Where:** Wallet Privacy Policy, "Scanning a receipt."
**Correction (2026-09-01):** this was inaccurate as of this writing --
`routes/customer-account.js` calls `fileStorage.putPrivate()`
(`lib/fileStorage.js`), which uploads to a real Supabase Storage private
bucket whenever `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`/
`SUPABASE_PRIVATE_BUCKET` are set -- confirmed set in `.env`, and verified
directly by pulling a real scanned receipt back out of that bucket. Local
disk (`public/uploads/receipt-scans/`) is only ever a fallback for an
environment with none of those configured. Access is gated too: photos are
served only through `GET /account/receipts/scanned/:id/image`, which
checks session ownership before streaming, never a public URL. No factual
gap remains here -- same reasoning as the IP-address correction at the
bottom of this file.

**28. No scheduled purge for `ScannedReceipt` rows individually — RESOLVED.**
**Where:** Wallet Privacy Policy, "How long we keep your data."
**Status: RESOLVED**, founder decision (2026-09-01): scanned receipts now
follow the same `SHOPPER_RECEIPT_MONTHS` schedule as tapped ones, kept
consistent so a shopper never has to know the two are handled differently
under the hood. Built `purgeExpiredScannedReceipts()` in
`services/dataRetentionService.js`, mirroring `purgeExpiredReceipts()`'s
shape (batched delete, dry-run default, one `PurgeLog` row per run), wired
into the same daily scheduled job in `server.js` right alongside it. The
cutoff is `purchaseDate` when the customer entered one, falling back to
`createdAt` (the upload time) otherwise — same precedence
`categorizeScannedInBackground` already uses for warranty dates, since a
scan's upload time isn't necessarily its purchase date. Photo removal from
storage is best-effort, same posture as every other file cleanup in this
service. Still gated behind `RETENTION_PURGE_ENABLED` like everything
else — see item 2 — so this doesn't turn on live deletion by itself.

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
