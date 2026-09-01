# Known Issues

Real, confirmed bugs found during other work, deliberately not fixed at the
time they were found because they were out of scope for the change in
progress. Not a backlog or a wishlist -- everything here has been read in the
actual code, not inferred.

---

## `routes/pdf-export.js` silently truncates at 200 receipts — RESOLVED

**Where:** `GET /dashboard/receipts/pdf-export` (merchant's own bulk PDF
export), `routes/pdf-export.js`.

**Status: RESOLVED** (2026-09-01). The route now runs a separate
`prisma.transaction.count({ where })` before the capped fetch and, if the
real total exceeds `MAX_PDF_EXPORT` (200), rejects with `400` and the
actual count: *"This date range matches 201 receipts, which is more than
the 200-receipt export limit. Narrow the date range and try again."*
Chosen over silently showing a truncated count, since bulk PDF generation
is expensive (a real Playwright render per receipt via
`generateReceiptPDFs`) -- better to ask for a narrower range up front than
spend that cost on an incomplete result. Verified end-to-end against a
real (temporary) merchant account: 201 matching receipts rejects with the
exact count; 200 passes through to generation.

**Correction to this entry's original text:** it referenced a
"shopper-side ZIP export (`/account/receipts/export/zip`)" as the
already-correct reference implementation this route should match. That
route doesn't exist in the current codebase -- the actual shopper-side
export (`GET /account/receipts/export/pdf`) produces one consolidated
report PDF, not a ZIP of individual receipt PDFs, and has no row-count
cap of its own. Either the referenced route was renamed/removed since
this was written, or the description was inaccurate when written. Worth
knowing if the shopper export is ever asked to handle very large exports:
it currently has no equivalent guardrail at all, capped or otherwise.

---

## Scanned receipts don't accept HEIC/HEIF photos (deliberate, not a bug)

**Where:** the receipt-scan upload flow -- `views/scan-receipt.ejs` (the
three upload paths), `routes/customer-account.js`
(`ALLOWED_SCAN_TYPES`, multer `fileFilter` in `handleReceiptScanUpload`),
`services/scanReceiptService.js` (`extractReceiptData`).

**Traced, layer by layer:**
1. `ALLOWED_SCAN_TYPES` is `['image/png', 'image/jpeg', 'image/webp']` --
   no `image/heic`/`image/heif`. iPhones shoot HEIC by default.
2. Of the three ways to supply a photo, only two can ever touch a HEIC
   file. The in-page camera button (the shutter) captures via
   `getUserMedia` into a `<canvas>` and calls `canvas.toBlob()` with no
   `type` argument, which always yields `image/png` -- it cannot produce
   HEIC regardless of the phone's camera settings. "Choose from library"
   and the plain file picker are the two inputs that can, but both declare
   `accept="image/png,image/jpeg,image/webp"`, and iOS Safari generally
   converts HEIC to JPEG in its native picker when the page's `accept`
   excludes it -- soft and OS/browser-version-dependent, not a guarantee,
   and nothing in this app's own JS does that conversion.
3. If a HEIC file gets past that anyway, multer's `fileFilter` (server-side,
   hard) rejects it before it reaches storage or extraction.
4. Even if it weren't rejected there: Claude's Messages API only accepts
   `image/jpeg`, `image/png`, `image/gif`, `image/webp` as an image
   `media_type` -- a HEIC buffer would fail the extraction call, which
   `extractReceiptData`'s `catch` already turns into a blank review form,
   not a crash.
5. Even if extraction weren't a problem: HEIC only renders in an `<img>`
   natively in Safari (WebKit's OS-level HEIF decoding on Apple platforms).
   Chrome and Firefox show a broken image. This wallet is meant to be
   opened across devices, not just the phone the photo was taken on, so a
   HEIC that somehow made it into storage would look fine on the iPhone it
   was uploaded from and broken everywhere else.

**Decision:** deliberately not converting or otherwise supporting HEIC.
Doing it properly means a native image-decoding library in the upload path
(Railway's container, not just local dev) purely to handle a case the
existing `accept` filtering already resolves in the common flow -- more
failure surface for an edge case that may rarely or never actually fire.
Fixed instead: the rejection copy (same `handleReceiptScanUpload`) now
names the in-page camera button as the path that can't hit this at all,
rather than listing file formats that mean nothing to someone who doesn't
know what their camera shoots.

**If revisited:** convert on upload, before extraction and storage --
never carry HEIC through the pipeline itself, per points 4 and 5 above.
Would need a native library (e.g. `sharp`, or `heic-decode`/`libheif`
bindings) confirmed working in Railway's build and runtime, not just
locally.

---

## Tapped receipts can't record the buyer's name (CRA's $500 rule) — RESOLVED

**Where:** `Transaction` model (`prisma/schema.prisma`) vs `ScannedReceipt`;
`lib/receiptMissingFields.js`'s `missingSubstantiationFields()`.

**Status: RESOLVED** (2026-09-01). Added `Transaction.buyerName`. Since a POS
webhook has no way to ask for one, it's filled automatically with the
shopper's own wallet profile name (`Customer.name`) the moment they claim
the receipt -- both claim paths write it (`services/claimReceipt.js` for a
tap/manual save, `services/receiptAutoSave.js` for card-recognition
auto-save), each with a one-time fetch of the shopper's name right before
the same update that sets `customerId`, so it can never overwrite a
correction made after the fact. Editable afterward via
`POST /account/receipts/tapped/:id/buyer-name`, same shape as
`businessPurpose`, shown as a "Billed to" card on `views/receipt.ejs`
gated on `isOwner`. Null if the shopper's profile had no name set at claim
time (email/password signup collects no name at all) and they haven't
typed one into Settings or the receipt page since.

`missingSubstantiationFields('tapped', ...)` now runs the same $500
buyer-name check `'scanned'` already had, instead of skipping it
unconditionally. The tax export's `exportDetailFor()` was also silently
hardcoding `buyerName: null` for every tapped row (`kind === 'scanned' ?
row.buyerName : null`) -- fixed to read the real field for both kinds.

**Found while:** enriching the customer tax export (CSV/PDF) with per-receipt
substantiation gaps, which is what surfaced that the two receipt kinds'
"missing" checklists weren't actually symmetric.

**Still a real limit:** this only closes the gap for a shopper who has set
a name somewhere (OAuth signup auto-fills it; email/password signup does
not, and it's a manual field in Settings). A blank profile at claim time
still means a blank buyer name until the shopper fills it in themselves —
same manual-entry reality `businessPurpose` already has.
