# TouchBistro API Access — Outreach Draft

TouchBistro has no public developer program: no developer portal
(`developer.touchbistro.com` does not resolve), no published API docs, and
no self-serve app registration. Access is granted case by case — you
approach them, they evaluate, commercial terms are agreed, and only then is
an API key issued.

So this is a business-development conversation, not a signup form. This file
is the outreach to start it, plus the technical detail to send if they ask
for it.

**Fill these in before sending:**

- `[YOUR NAME]` — how you want to sign it
- `[YOUR EMAIL]` — the address you want their reply to reach
- `[YOUR TITLE]` — "Founder" is fine

---

## Read this first: the one answer that decides everything

TouchBistro is a **hybrid** system. The POS "brain" is a Mac mini physically
in the restaurant holding the data locally, syncing to their cloud for
reporting — deliberately, so the restaurant keeps taking payments during an
internet outage.

ReceipTap needs the opposite. A tap only produces a receipt if the puck has
a live `currentTransactionId` that hasn't passed `transactionExpiresAt`
(`routes/pucks.js:34-44`) — a **3-minute window**. The whole chain has to
finish in seconds: customer pays → POS fires an event → we write the
`Transaction` → customer taps. Miss the window and they get the "no live
receipt" page instead of their receipt.

A cloud sync built for *reporting* is usually batched, not instant. Whether
TouchBistro's can push a sale event in real time could not be determined
from outside, because the docs are private.

**So get this answered before anything about pricing, terms, or timelines.**
It is question 1 in the email below on purpose:

> Does the API push a webhook on sale completion in real time (seconds), or
> is sale data only available on a polling/reporting sync?

Listen for:

- **"Real-time webhook on sale close"** → viable. Continue the conversation.
- **"Polling, every N minutes"** → check the smallest N. Anything over ~1
  minute cannot hit a 3-minute tap window reliably, and polling every
  merchant every minute is a cost problem of its own.
- **"Reporting sync, hourly/nightly"** → **not viable at any price.** Stop
  here and put the effort into a POS that can. Say thanks, keep the door
  open, and don't negotiate terms for something that can't work.

That last outcome is worth reaching on the first call rather than after
three months of back-and-forth.

---

## The email

**Subject:** Integration partner request — ReceipTap (digital receipts, NFC)

Hi,

I'm the founder of ReceipTap, a digital-receipt product for restaurants and
retailers. I'd like to talk about becoming an integration partner.

**What it does:** a passive NFC puck sits beside the register. After paying,
the customer taps their phone and gets their receipt instantly — no app, no
account, no email typed at the counter. The restaurant gets opt-in email
capture and a review funnel; the customer gets a receipt that isn't a curling
strip of thermal paper.

**What it would need from TouchBistro:** read-only access to completed sale
data — line items, subtotal, tax, total, check number, timestamp, and which
register rang it — plus a real-time notification when a sale closes.

**Three questions, in priority order:**

1. Does the API push a webhook when a sale is completed, in real time? Our
   product only works if a receipt is ready within seconds of payment — the
   customer is standing at the counter with their phone out. If sale data is
   only available on a polling or reporting sync, that's the deciding factor
   for us and I'd rather know now than take up more of your time.
2. What does the approval process look like, and what commercial terms
   typically apply to an integration like this?
3. Is access granted per-partner (one set of credentials, merchants
   authorize us) or per-merchant (each restaurant obtains their own key)?
   That changes the onboarding experience we'd build.

For context on where we are: ReceipTap already has working integrations
with Square, Clover, Lightspeed, and Shopify — Square and Clover proven
end-to-end with real transactions, not just sandbox — all built on the same
pattern — the merchant authorizes us, we subscribe to their sale events, we
never write anything back. Our merchant access tokens are deliberately
read-only. We don't touch card data; payment details never reach our servers.

We're pre-launch, so I'm not going to overstate volume — this is about
building the integration properly before merchants are asking for it, not
about numbers I don't have yet.

Happy to have our technical side talk directly with yours if that's the
faster path.

Thanks,
[YOUR NAME]
[YOUR TITLE], ReceipTap
J.A.C. GLOBAL APPROACH LTD.
[YOUR EMAIL]

---

## Technical appendix — send only if they ask

Every fact below is traceable to code in this repo. Don't add to it from
memory; if they ask something not answered here, check the code first.

### Data we would read

Exactly the fields on our `Transaction` model — nothing else:

| Field | Purpose |
|---|---|
| Line items: name, quantity, unit price, line total | Printed on the receipt |
| `subtotal`, `tax`, `discountTotal`, `total` | Printed on the receipt |
| Check / order number | Printed on the receipt |
| Sale timestamp | Receipt date, and expiring the tap window |
| Register or location identifier | Routes the sale to the right puck |
| Payment method, if available | Printed on the receipt (optional — Lightspeed doesn't expose it and we handle its absence) |

### Data we would not read

- No cardholder data, PAN, or payment credentials — these never reach our
  servers under any integration.
- No POS-side customer records, loyalty profiles, or marketing lists. Emails
  in ReceipTap are given to us by the customer at the tap screen, with
  consent recorded per tap; we don't ingest a merchant's existing customer
  list from their POS.
- No staff, labour, scheduling, or inventory data.

### Writes

None, against a merchant account. Our merchant tokens are read-only by
design — see the comment on `createTestSale()` in
`services/squareService.js:21-23`: the only code that creates a sale uses a
separate sandbox test token, explicitly because a real merchant's token
can't. The only non-read call we make against a live merchant account is
creating our own webhook subscription at connect time, where the platform
requires it (Lightspeed and Shopify both do; Square doesn't).

### Comparable scopes already granted to us

- **Square:** `MERCHANT_PROFILE_READ PAYMENTS_READ ORDERS_READ`
- **Lightspeed X-Series:** `sales:read outlets:read registers:read taxes:read products:read webhooks`
- **Shopify:** `read_orders`

A TouchBistro equivalent would be "read completed sales, plus a sale-closed
event." Narrower than any of the above if they'd prefer — we don't need
product catalogue or profile access if the sale payload carries item names.

### Security

- Merchant access tokens stored server-side; never exposed to a browser.
- Webhook payloads signature-verified before processing — real HMAC
  verification, not a placeholder (`verifySquareSignature()` in
  `routes/webhooks.js` is the reference implementation).
- Database hosted in Canada (AWS `ca-central-1`).
- Card data never touches our servers; subscription billing is Stripe-hosted.
- A Privacy Policy, Terms of Service, and Data Processing Agreement are
  drafted and served at `/legal/privacy`, `/legal/terms`, and `/legal/dpa`,
  with every subprocessor disclosed by name and a versioned, append-only
  record of what each merchant agreed to. They are pre-launch and still
  carry open items for legal review — say so if asked rather than
  presenting them as finalized.

### Scale, honestly

Pre-launch. Live integrations built and tested end-to-end with real
transactions on Square and Clover; no paying merchants yet. Don't inflate
this — a gatekeeper who catches one exaggeration discounts everything else
in the request.

---

## If they say yes

Don't start writing code from a phone call. Get, in writing:

1. The auth model — OAuth with an authorize URL and token endpoint, or a
   static per-merchant API key? This decides whether the integration follows
   `routes/oauth-lightspeed.js` or needs a new shape entirely.
2. The sale-completed event payload, with a real example.
3. How webhook signatures are verified.
4. Whether a sandbox or test restaurant is available.
5. Whether the identifier for "which register rang this" is exposed — the
   puck-to-register binding depends on it.

Until those five are answered, there's nothing worth building. Adding schema
fields ahead of that is guesswork: the `shopifyShopDomain` /
`shopifyAccessToken` fields sat in the schema as dead scaffolding long
enough that `docs/DATA_INVENTORY.md` catalogued them as a gap and the
privacy policy went stale describing them.
