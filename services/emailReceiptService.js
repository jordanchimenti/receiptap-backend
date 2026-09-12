// services/emailReceiptService.js
// The orchestration layer between services/emailProviderService.js (talks
// to Nylas) and the existing receipt-creation model. Two entry points,
// matching the two places messages arrive from (routes/emailWebhook.js for
// live new-message events, services/emailReceiptPoller.js for both the
// pending-classification queue AND the bounded first-connect backfill):
//
//   recordCandidateFromSummary()  -- cheap, synchronous, no AI call. Called
//                                    from the webhook route and from the
//                                    backfill loop. Writes a `pending`
//                                    ProcessedEmailMessage row for anything
//                                    that passes the sender/subject filter,
//                                    and nothing at all for anything that
//                                    doesn't -- there is no database trace
//                                    of a message that never looked like a
//                                    candidate in the first place.
//
//   processPendingMessage()       -- the expensive half. Called only by
//                                    services/emailReceiptPoller.js, never
//                                    from the webhook request itself (see
//                                    docs/CONSUMER_FLOW_AUDIT.md section 7
//                                    for why: no job queue exists in this
//                                    codebase, so the webhook stays fast and
//                                    a poller does the AI-call-bearing work
//                                    in small batches). Fetches the FULL
//                                    message body for the first time here --
//                                    everything before this point only ever
//                                    saw a summary (sender/subject/snippet).
//                                    Either creates a ScannedReceipt (+ its
//                                    source document) and finalizes the
//                                    ProcessedEmailMessage row as 'receipt',
//                                    or finalizes it as 'rejected' and
//                                    discards the fetched content --
//                                    nothing about a rejected message's
//                                    content is ever written to the
//                                    database, only the fact that it was
//                                    looked at and rejected.

const crypto = require('crypto');
const prisma = require('../lib/prisma');
const fileStorage = require('../lib/fileStorage');
const { looksLikeReceiptCandidate } = require('../config/emailSenderHeuristics');
const { extractReceiptDataFromEmail } = require('./scanReceiptService');
const { getMessage, downloadAttachment } = require('./emailProviderService');
const { findDuplicateReceipt, normalizeMerchant } = require('../lib/findDuplicateReceipt');

// Deliberately no HTML parsing library -- this only needs to strip tags
// well enough for an LLM prompt, not to render anything, and this
// codebase's own stated preference (services/paypalService.js's header
// comment) is to skip a dependency when hand-rolling the small amount
// actually needed is this straightforward.
function htmlToPlainText(html) {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Bounds on the PDF-fallback extraction path below -- a message that needed
// this fallback already passed the sender/subject filter, but that filter
// says nothing about how large or how many PDFs it's attached, and this is
// the one place in the whole pipeline that pays for an attachment download
// before knowing whether the message is even a receipt. 15MB comfortably
// covers a real invoice/receipt PDF while keeping a hostile or oversized
// attachment from turning into an expensive download + a large Anthropic
// call; 2 attachments is enough for the real pattern this exists for (an
// invoice plus a payment confirmation), not an invitation to process an
// email's entire attachment list.
const MAX_PDF_BYTES_FOR_EXTRACTION = 15 * 1024 * 1024;
const MAX_PDFS_FOR_EXTRACTION = 2;

function extractSenderDomain(fromAddress) {
  const at = String(fromAddress || '').lastIndexOf('@');
  return at === -1 ? null : fromAddress.slice(at + 1).trim().toLowerCase();
}

/** Finds or creates the unconnected-merchant identity a sender domain maps
 * to -- see MerchantRegistry's schema comment for the full reasoning.
 * senderDomain is unique, so this is a plain find-or-create, no fuzzy
 * matching needed at the domain level (fuzzy matching already happened one
 * layer up, if at all, when the sender passed the heuristics filter). */
async function findOrCreateMerchantRegistry({ senderDomain, displayName }) {
  if (!senderDomain) return null;
  const existing = await prisma.merchantRegistry.findUnique({ where: { senderDomain } });
  if (existing) return existing;
  return prisma.merchantRegistry.create({
    data: { senderDomain, normalizedName: normalizeMerchant(displayName || senderDomain), displayName: displayName || senderDomain },
  });
}

/** The cheap, synchronous half. `summary` is whatever the webhook payload
 * or a listMessages() page already gives us -- from/subject/snippet,
 * providerMessageId -- never a full body. Idempotent: a message already
 * seen (by providerMessageId) is silently skipped, whichever path saw it
 * first (webhook vs. backfill) wins. */
async function recordCandidateFromSummary(emailConnection, summary) {
  const existing = await prisma.processedEmailMessage.findUnique({
    where: { providerMessageId: summary.id },
  });
  if (existing) return existing;

  if (!looksLikeReceiptCandidate({ from: summary.from?.[0]?.email || summary.from, subject: summary.subject, snippet: summary.snippet })) {
    // Never persisted at all -- per the spec, a message that doesn't even
    // look like a candidate leaves no trace, not even a rejected row.
    return null;
  }

  return prisma.processedEmailMessage.create({
    data: {
      emailConnectionId: emailConnection.id,
      providerMessageId: summary.id,
      status: 'pending',
    },
  });
}

/** The expensive half -- full fetch, classify+extract, create-or-reject.
 * `processedMessage` is a `status: 'pending'` row from the function above.
 * Never throws for an ordinary "this wasn't a receipt" outcome -- only for
 * genuine failures (Nylas API error, DB error), so the poller's batch loop
 * can tell the difference between "finish this row as rejected" and "leave
 * this row pending and retry next tick." */
async function processPendingMessage(processedMessage, emailConnection) {
  const message = await getMessage(emailConnection.grantId, processedMessage.providerMessageId);

  const bodyText = htmlToPlainText(message.body) || message.snippet || '';
  const senderDomain = extractSenderDomain(message.from?.[0]?.email);

  // Nylas (like most providers) often reports a Content-Type WITH
  // parameters, e.g. "application/pdf; name=invoice.pdf" -- a strict
  // equality check against 'application/pdf' silently misses every one of
  // those, which is most real-world PDF attachments, not an edge case.
  // Comparing only the base media type (before any ';') is what both the
  // fallback below and the source-document storage further down actually
  // need.
  const pdfAttachments = Array.isArray(message.attachments)
    ? message.attachments.filter((a) => String(a.content_type || '').split(';')[0].trim() === 'application/pdf')
    : [];

  let extracted = null;
  if (bodyText.trim()) {
    extracted = await extractReceiptDataFromEmail(bodyText);
  }

  // Fallback for the "your invoice is attached" pattern: the email body
  // alone said nothing usable, but a PDF is attached that might actually
  // hold the receipt. Only reached when body-only extraction already
  // failed, so the common case (a receipt fully written into the email
  // itself) never pays for a PDF download it doesn't need -- same
  // data-minimization posture as everything else in this file, just
  // applied one step later than the sender/subject filter above.
  // downloadedPdfs is filled in here and reused below when storing this
  // message's original documents, so a message that needed this fallback
  // never downloads the same PDF twice.
  const downloadedPdfs = new Map(); // attachment.id -> Buffer
  if ((!extracted || !extracted.merchantName || extracted.totalCents == null) && pdfAttachments.length) {
    const candidates = pdfAttachments
      .filter((a) => !a.size || a.size <= MAX_PDF_BYTES_FOR_EXTRACTION)
      .slice(0, MAX_PDFS_FOR_EXTRACTION);
    const buffers = [];
    for (const attachment of candidates) {
      try {
        const buffer = await downloadAttachment(emailConnection.grantId, attachment.id, message.id);
        if (buffer.length > MAX_PDF_BYTES_FOR_EXTRACTION) continue; // a.size wasn't trustworthy
        downloadedPdfs.set(attachment.id, buffer);
        buffers.push(buffer);
      } catch (err) {
        console.error(`[email-receipt] attachment download failed for message ${message.id}:`, err.message);
      }
    }
    if (buffers.length) {
      extracted = await extractReceiptDataFromEmail(bodyText, buffers);
    }
  }

  if (!extracted || !extracted.merchantName || extracted.totalCents == null) {
    await prisma.processedEmailMessage.update({
      where: { id: processedMessage.id },
      data: { status: 'rejected' },
    });
    return { created: false };
  }

  // Business-level dedupe, on top of the message-ID dedupe above -- the
  // same purchase legitimately arrives as more than one email (order
  // confirmation, shipping notice, receipt). Reuses the exact matching
  // lib/findDuplicateReceipt.js already does for scan-vs-scan and
  // scan-vs-tap duplicates, extended here to catch email-vs-email.
  const duplicate = await findDuplicateReceipt({
    customerId: emailConnection.customerId,
    merchantName: extracted.merchantName,
    totalCents: extracted.totalCents,
    purchaseDate: extracted.date,
  });

  if (duplicate?.kind === 'tapped') {
    // Already captured live via POS -- richer data than an email could add.
    // Nothing further to attach it to (ScannedReceiptSourceDocument only
    // links to ScannedReceipt, deliberately -- see its schema comment), so
    // this message's job is done once it's on record as reviewed.
    await prisma.processedEmailMessage.update({
      where: { id: processedMessage.id },
      data: { status: 'rejected' },
    });
    return { created: false, duplicateOf: duplicate };
  }

  // Nylas's list/get message endpoints return parsed fields (subject, body,
  // from, attachments), not the raw MIME source, by default -- confirm
  // during Phase 1 setup whether Nylas exposes a raw-source fetch (a
  // separate endpoint/param, not a normal message field) and wire it in if
  // so, for a truer "exactly what the customer's inbox held" original.
  // Until then, the honest artifact is the plain-text rendering already
  // computed above for extraction -- labeled as what it actually is
  // ('email_text'), never mislabeled as a PDF it isn't.
  const rawEml = typeof message.raw_mime === 'string' ? message.raw_mime : null;
  const artifactBuffer = Buffer.from(rawEml || bodyText, 'utf8');
  const artifactType = rawEml ? 'email_eml' : 'email_text';
  const contentHash = crypto.createHash('sha256').update(artifactBuffer).digest('hex');

  // putPrivate returns the bare storage key as a string (see
  // lib/fileStorage.js), not an object -- same call shape scan uploads
  // already use. Filename includes both the message ID and a hash-safe
  // random-ish suffix would be unnecessary here since providerMessageId is
  // already globally unique per Nylas grant; upsert:false inside
  // putPrivate means a retry of this exact message after a prior partial
  // failure would hit a duplicate-key error rather than silently
  // overwriting -- acceptable for Phase 1 (surfaces as a retry failure the
  // poller logs, not silent data loss), worth revisiting if retries turn
  // out to be common in practice.
  const storageKey = await fileStorage.putPrivate('email-receipts', {
    originalname: `${processedMessage.providerMessageId}.${rawEml ? 'eml' : 'txt'}`,
    buffer: artifactBuffer,
    mimetype: rawEml ? 'message/rfc822' : 'text/plain',
  }, { prefix: emailConnection.customerId });

  // A merchant-attached PDF is a real, separate original alongside the
  // email itself -- e.g. an invoice PDF next to a short "your invoice is
  // attached" email body. Fetched and stored here (outside the DB
  // transaction below, since these are slow external calls), one
  // ScannedReceiptSourceDocument row per attachment, never used to decide
  // whether this message IS a receipt (that's already been decided from
  // the email body above) -- only ever additive evidence.
  const attachmentArtifacts = [];
  for (const attachment of pdfAttachments) {
    try {
      // Reuse the buffer if the PDF-fallback path above already downloaded
      // this exact attachment while trying to extract a receipt from it --
      // no reason to fetch the same bytes from Nylas twice.
      const buffer = downloadedPdfs.get(attachment.id)
        || await downloadAttachment(emailConnection.grantId, attachment.id, message.id);
      const key = await fileStorage.putPrivate('email-receipts', {
        originalname: attachment.filename || `${attachment.id}.pdf`,
        buffer,
        mimetype: 'application/pdf',
      }, { prefix: emailConnection.customerId });
      attachmentArtifacts.push({
        type: 'attachment_pdf',
        storageKey: key,
        contentHash: crypto.createHash('sha256').update(buffer).digest('hex'),
      });
    } catch (err) {
      // A failed attachment fetch must not sink the receipt itself -- the
      // email body already has everything needed to create it.
      console.error(`[email-receipt] attachment download failed for message ${message.id}:`, err.message);
    }
  }

  const registry = await findOrCreateMerchantRegistry({
    senderDomain,
    displayName: extracted.merchantName,
  });

  const result = await prisma.$transaction(async (tx) => {
    let scannedReceipt;
    if (duplicate?.kind === 'scanned') {
      // Enrich the existing receipt with this email as an additional
      // original, rather than creating a second receipt row for the same
      // purchase -- "how updates merge," per the spec's own question.
      scannedReceipt = await tx.scannedReceipt.findUnique({ where: { id: duplicate.id } });
    } else {
      scannedReceipt = await tx.scannedReceipt.create({
        data: {
          customerId: emailConnection.customerId,
          imageUrl: storageKey, // the email original doubles as "the photo" slot for this row -- see source doc below for the real artifact
          merchantName: extracted.merchantName,
          merchantAddress: extracted.merchantAddress,
          merchantPhone: extracted.merchantPhone,
          cashierName: extracted.cashierName,
          itemCount: extracted.itemCount,
          purchaseDate: extracted.date ? new Date(extracted.date) : null,
          purchaseTimeText: extracted.timeText,
          total: extracted.totalCents,
          subtotal: extracted.subtotalCents,
          tax: extracted.taxCents,
          taxLabel: extracted.taxLabel,
          tip: extracted.tipCents,
          currency: extracted.currency,
          taxNumber: extracted.taxNumber,
          taxNumber2: extracted.taxNumber2,
          buyerName: extracted.buyerName,
          paymentMethod: extracted.paymentMethod,
          paymentReferenceNumber: extracted.paymentReferenceNumber,
          receiptNumber: extracted.receiptNumber,
          aiCategory: extracted.category,
          lineItems: extracted.lineItems,
          source: 'email',
          merchantRegistryId: registry?.id || null,
        },
      });
    }

    await tx.scannedReceiptSourceDocument.create({
      data: {
        scannedReceiptId: scannedReceipt.id,
        type: artifactType,
        storageKey,
        contentHash,
      },
    });

    for (const artifact of attachmentArtifacts) {
      await tx.scannedReceiptSourceDocument.create({
        data: { scannedReceiptId: scannedReceipt.id, ...artifact },
      });
    }

    await tx.processedEmailMessage.update({
      where: { id: processedMessage.id },
      data: { status: 'receipt', scannedReceiptId: scannedReceipt.id },
    });

    return scannedReceipt;
  });

  // Phase 2 hooks in here -- a push notification deep-linking to
  // result.id, mirroring notifyLoyaltyCardFull's shape (see
  // docs/CONSUMER_FLOW_AUDIT.md's phased plan). Not called in Phase 1 on
  // purpose, to keep this phase's test surface on "does parsing work well
  // against real inboxes," not notification delivery.

  return { created: true, scannedReceipt: result };
}

module.exports = {
  htmlToPlainText,
  findOrCreateMerchantRegistry,
  recordCandidateFromSummary,
  processPendingMessage,
};
