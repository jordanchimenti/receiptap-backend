// lib/parseReceiptFields.js
// Turning what someone typed on a receipt-review screen into what the database
// will accept.
//
// This exists because it once didn't. `Math.round(parseFloat(total) * 100)` on
// "$12.34" gives NaN, NaN went into an Int column, Prisma threw, nothing caught
// it, and the request hung without ever answering -- which from a phone looked
// like the Save button was simply broken. Same shape of bug for dates: a string
// that isn't a date makes an Invalid Date, which throws exactly the same way.
//
// Pure and dependency-free so both can be tested without a database.

// Accepts what people and OCR actually produce: "12.34", "$12.34", "1,234.50",
// " 12.34 ". Returns cents, or null when there is no sensible amount in there.
// Money is stored in cents as integers everywhere in this project.
function parseMoneyToCents(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;

  // Strip currency symbols, thousands separators and spaces. The minus is kept
  // so a negative reads as negative and gets rejected below, rather than
  // silently becoming a positive charge.
  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  const amount = parseFloat(cleaned);

  // Rejects NaN, Infinity, zero and negatives: a receipt total is a positive
  // amount, and zero is far more likely to be a misread than a real purchase.
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return Math.round(amount * 100);
}

// Empty means "no date given", which is allowed. A string that isn't a date
// also means null rather than an Invalid Date -- better to save the receipt
// without a date than to refuse to save it at all.
function parseDateOrNull(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

module.exports = { parseMoneyToCents, parseDateOrNull };
