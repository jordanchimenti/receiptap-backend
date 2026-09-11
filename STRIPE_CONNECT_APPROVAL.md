# Stripe Connect Approval — ReceipTap Balance Withdrawals

This document is for Stripe's review (risk/financial partnerships or Connect
support), submitted by ReceipTap ahead of enabling Instant Payout monetization
and confirming the withdrawal feature described below is supported as built.

## What ReceipTap is

ReceipTap is a consumer digital-receipt platform. A passive NFC puck sits
beside a merchant's register; a customer taps their phone after paying and
gets a digital receipt instantly. Customers also get a cross-merchant wallet
with categorized receipts, and can photograph/upload receipts from anywhere,
not just ReceipTap merchants.

Legal entity: J.A.C. GLOBAL APPROACH LTD. (Ontario, Canada). Countries of
operation for this request: **Canada and the United States**.

## Two Stripe Connect use cases already live

### 1. Split the Bill (existing, live)

A ReceipTap wallet customer ("the host") photographs or links a receipt,
splits it among friends ("guests"), and shares one link. A guest opens the
link — no ReceipTap account required — and pays their portion by card, Apple
Pay, or Google Pay. This is a **destination charge**: the PaymentIntent is
created on ReceipTap's platform account, but `transfer_data.destination`
routes the full amount directly to the host's own Stripe Connect Express
account as part of the same charge. ReceipTap's platform balance never holds
this money, even momentarily. Hosts are onboarded as individual Express
accounts (`business_type: 'individual'`, `capabilities: { transfers: {
requested: true } }`) via Stripe-hosted onboarding.

### 2. Affiliate payouts (existing, live)

Independent of Split the Bill: ReceipTap's referral partners (affiliates) are
also onboarded as Connect Express accounts, and are paid via
`stripe.transfers.create` — a genuine transfer out of ReceipTap's own platform
balance, tracked against a `Commission` ledger. This is a different funds-flow
from Split the Bill and is not the subject of this request, but is disclosed
here since it uses the same underlying Connect account type.

## The new ask: host withdrawals

Today, a Split the Bill host's collected reimbursements sit in their own
Stripe Connect balance, but ReceipTap has no in-app way for them to see or
withdraw it — they'd have to use Stripe's own hosted dashboard, which this
app never links them to. We've built:

- **A "ReceipTap Balance" screen** showing the host's own connected-account
  balance (Available / Pending), read live from Stripe's Balance API — never
  computed from ReceipTap's own database.
- **Standard withdrawal**: `stripe.payouts.create()` on the host's own
  connected account, no fee, normal bank timing.
- **Instant withdrawal**: shown only when Stripe reports the account and its
  external account are Instant-Payout-eligible. ReceipTap intends to charge a
  **3% fee**, via Stripe's Platform Pricing Tool (Application Fees) — this is
  a Dashboard-configured setting, not something ReceipTap's own code
  computes or deducts.

### Example transaction

A $300 restaurant bill, split three ways ($100 each):

- Bill total: $300. Host's own share: $100 (not collected). Amount to
  collect from guests: $200.
- Two guests each pay $100 via their own card, each as a separate destination
  charge routed to the host's Connect balance.
- The host's ReceipTap Balance now shows Available: ~$200 (minus Stripe's
  standard processing fees).
- The host withdraws: Standard ($200, no ReceipTap fee, arrives in 1-2
  business days) or Instant ($200 minus a 3% ReceipTap fee minus Stripe's own
  1% underlying Instant Payout cost, arriving within minutes).

**Who the payer is**: each guest, paying with their own card for their own
share of a real shared expense.
**Who the host is**: the ReceipTap consumer who paid the original bill and is
being reimbursed by their guests.
**Why hosts receive money**: they already paid the merchant in full and are
collecting reimbursement from the people they split the bill with — this is
peer reimbursement for a real, already-incurred shared expense, not a
transfer for its own sake.
**How withdrawals work**: described above — the host pulls their own balance
to their own bank via Stripe payouts, initiated from inside ReceipTap.
**How ReceipTap makes money on this feature**: only the disclosed 3% Instant
Withdrawal fee, if approved (see below). Standard withdrawal is free to the
host. ReceipTap does not currently charge a fee on the underlying Split the
Bill payment collection itself, though this document also discloses that
ReceipTap may introduce a disclosed split/payment service fee in the future.

## What we're asking Stripe to confirm

1. Can this use case — consumers splitting and reimbursing legitimate shared
   expenses, paid via Stripe, withdrawn by the host to their own verified
   bank account from inside ReceipTap — be supported using Stripe Connect for
   users in Canada and the United States?
2. Can individual consumers receiving reimbursements be onboarded as
   connected accounts (as they already are today for Split the Bill)?
3. Which current Connect account configuration should ReceipTap use — should
   the existing `type: 'express'` accounts be migrated to controller
   properties (`fees.payer`, `losses.payments`, `requirement_collection`), or
   is the current configuration sufficient for withdrawals specifically?
4. Which capabilities should we request — is `transfers` alone sufficient for
   an account that will now also *initiate* payouts, not just receive
   destination-charge transfers?
5. Which charge/funds-flow architecture should we use — do destination
   charges remain correct now that the host will also withdraw, or does
   enabling payouts change this recommendation?
6. Can hosts withdraw directly to Canadian and U.S. bank accounts?
7. Can standard payouts be provided to ReceipTap users without an additional
   user-facing withdrawal fee — i.e. is a $0-fee standard payout something
   ReceipTap can simply not charge for, with no separate approval needed?
8. Can ReceipTap charge a configurable fee for Instant Payouts, and confirm
   our understanding that this is done via the Platform Pricing Tool /
   Application Fees because destination charges already make ReceipTap the
   fee payer on these accounts, without needing to change any other account
   setting?
9. If Stripe's underlying Instant Payout cost (1%, per Stripe's own published
   pricing) is lower than ReceipTap's disclosed 3% user-facing fee, can
   ReceipTap retain the difference?
10. How should this markup be implemented correctly — is the Platform
    Pricing Tool the recommended mechanism, or should ReceipTap instead use
    an explicit `application_fee_amount` computed by our own code?
11. What KYC information will hosts need to provide, given they were
    originally onboarded only to *receive* destination-charge transfers and
    will now also *withdraw* via payouts?
12. Can onboarding and payout management remain embedded in ReceipTap (the
    existing Stripe-hosted onboarding-link flow, or Stripe's embedded
    `account_onboarding` component), rather than sending hosts to Stripe's
    own dashboard?
13. What transaction or risk limits apply to an individual Express account
    under this model?
14. Does Stripe consider this shared-expense reimbursement, P2P money
    transmission, marketplace activity, or another category?
15. Does this require additional approval from Stripe's financial
    partnerships or risk team beyond what Split the Bill's existing
    destination-charge flow already required?

## Status

**Not yet approved.** This document is the submission itself. No claim of
Stripe approval should be inferred from anything in this codebase until
Stripe responds in writing. The Instant Withdrawal fee UI is built (see
`config/payouts.js`, `routes/customer-payouts.js`) but its actual collection
mechanism (the Dashboard's Platform Pricing Tool) has not yet been configured
or tested against a real Instant Payout, and should not be enabled in
production until confirmed.
