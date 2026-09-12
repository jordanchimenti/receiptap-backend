// config/emailSenderHeuristics.js
// The cheap, no-AI-call first-pass filter services/emailReceiptService.js
// runs against a message's SUMMARY (sender, subject, snippet -- never the
// full body, per the data-minimization requirement in
// docs/CONSUMER_FLOW_AUDIT.md) before ever fetching that message in full.
// Deliberately data, not code -- a new high-volume sender (per the original
// spec's own list: Square, Shopify, Uber/Uber Eats, DoorDash, Amazon,
// Instacart, Skip, airlines/hotels) gets added here, never by touching
// services/emailReceiptService.js itself.
//
// A message passes the filter if EITHER its sender domain matches
// SENDER_DOMAINS, OR its subject/snippet matches enough of
// SUBJECT_KEYWORDS/BODY_SIGNAL_KEYWORDS to look like a receipt. Matching
// only means "worth spending one classification+extraction AI call on" --
// it is not itself a decision that something IS a receipt.

// Exact domains or domain suffixes known to send real purchase receipts.
// A message from any of these always passes the filter regardless of
// subject wording, since these senders don't need a subject-line hint --
// their being the sender IS the signal.
const SENDER_DOMAINS = [
  'messaging.squareup.com', // Square's auto-receipt sender -- see the spec's
  // own note: every card-linked purchase at any Square seller generates one
  // of these, making it the single richest in-store source available.
  'squareup.com',
  'shopify.com',
  'shopifyemail.com',
  'uber.com',
  'uber.com.au',
  'ubereats.com',
  'doordash.com',
  'amazon.com',
  'amazon.ca',
  'instacart.com',
  'skipthedishes.com',
];

// Words/phrases that suggest a purchase, checked against subject line and
// snippet for senders NOT already on the domain allowlist above.
const SUBJECT_KEYWORDS = [
  'receipt', 'order confirmation', 'your order', 'order #', 'order number',
  'invoice', 'payment received', 'thank you for your purchase',
  'purchase confirmation', 'booking confirmation', 'itinerary',
  'shipping confirmation', 'your receipt',
];

// Cheaper, weaker signals -- presence of a currency amount or "total" near
// the snippet, used to catch a receipt whose subject line is generic (e.g.
// "Your receipt from [Merchant]" already matched above, but "Here's your
// order" wouldn't be without this).
const BODY_SIGNAL_KEYWORDS = ['total', 'subtotal', 'amount charged', 'grand total'];

function normalizeDomain(fromAddress) {
  const at = String(fromAddress || '').lastIndexOf('@');
  return at === -1 ? '' : fromAddress.slice(at + 1).trim().toLowerCase();
}

/** Cheap pass/fail against a message SUMMARY only -- sender + subject +
 * snippet, never a full body. Returns a boolean, not a confidence score:
 * this is a coarse filter to avoid wasting an AI call on obvious non-
 * receipts (newsletters, personal email), not the actual receipt/not-
 * receipt decision -- that's services/emailReceiptService.js's
 * classification step, which runs only on messages that pass this. */
function looksLikeReceiptCandidate({ from, subject, snippet }) {
  const domain = normalizeDomain(from);
  if (SENDER_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;

  const haystack = `${subject || ''} ${snippet || ''}`.toLowerCase();
  if (SUBJECT_KEYWORDS.some((kw) => haystack.includes(kw))) return true;
  if (BODY_SIGNAL_KEYWORDS.some((kw) => haystack.includes(kw))) return true;

  return false;
}

module.exports = { SENDER_DOMAINS, SUBJECT_KEYWORDS, BODY_SIGNAL_KEYWORDS, looksLikeReceiptCandidate };
