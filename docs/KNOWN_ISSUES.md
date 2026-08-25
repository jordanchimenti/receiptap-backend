# Known Issues

Real, confirmed bugs found during other work, deliberately not fixed at the
time they were found because they were out of scope for the change in
progress. Not a backlog or a wishlist -- everything here has been read in the
actual code, not inferred.

---

## `routes/pdf-export.js` silently truncates at 200 receipts

**Where:** `GET /dashboard/receipts/pdf-export` (merchant's own bulk PDF
export), `routes/pdf-export.js`.

**Issue:** `MAX_PDF_EXPORT = 200` is applied as a plain Prisma `take: 200` on
the transaction query, with `orderBy: { createdAt: 'desc' }`. If a merchant's
date range matches more than 200 transactions, the export silently returns
only the 200 most recent and says nothing about the rest -- no count shown,
no warning in the response, no indication in the downloaded ZIP that
anything was left out. A merchant pulling records for their own bookkeeping
or an audit would have no way to know their export is incomplete.

**Found while:** building the shopper-side ZIP export
(`/account/receipts/export/zip`), which intentionally does the opposite --
rejects with a clear message and asks the shopper to narrow their date range
rather than truncating silently, since silent gaps are a worse failure in a
document meant to support a tax claim.

**Needed:** either show the truncation (e.g. "showing the 200 most recent of
312 matching receipts, narrow your date range for the rest") or reject with
a clear message the same way the shopper-side export now does. Not fixed
here -- flagged only, per the same reasoning as the retention-purge bugs in
`services/dataRetentionService.js` (real, confirmed, deliberately deferred).

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
