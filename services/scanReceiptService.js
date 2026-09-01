// services/scanReceiptService.js
// Reads a photographed/uploaded receipt image and extracts everything the
// paper actually prints, via Claude's vision support. Unlike
// categorize-receipt.js's fire-and-forget best-effort categorization, this is
// called synchronously and its result is shown to the customer for
// review/correction before anything is saved -- so a failure here doesn't get
// silently dropped the same way; the caller falls back to a blank review form.
//
// The field list deliberately mirrors what a POS-issued receipt carries
// (subtotal, tax, tip, tax number, currency, address), so a scanned receipt
// and a tapped one look like the same kind of object in the wallet instead of
// the scanned one being a bare total.
//
// NOT extracted, on purpose: card brand and card number digits as separate
// fields. `paymentMethod` already captures what the receipt shows ("Visa ••••
// 6123") as one opaque string, and ReceipTap does not collect real card data
// anywhere else -- breaking that out into its own column would be a step
// backwards for no gain.

const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { CATEGORIES } = require('./categorize-receipt');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Strict tool use rather than "reply with only JSON": the response is
// guaranteed to match this schema, which removes the previous failure mode of
// parsing fenced text with a regex and throwing on anything unexpected.
const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    merchantName: { type: ['string', 'null'], description: 'The store or business name as printed.' },
    merchantAddress: { type: ['string', 'null'], description: 'Street address printed on the receipt, one line. Null if not shown.' },
    merchantPhone: { type: ['string', 'null'], description: "The store's own phone number, exactly as printed (keep whatever formatting it uses). Null if not shown." },
    cashierName: { type: ['string', 'null'], description: 'The cashier/server\'s name as printed (e.g. "Your cashier today is Bhavyakumar P.", "Served by: Maria"). Null if not shown.' },
    itemCount: { type: ['integer', 'null'], description: 'The item count printed on the receipt itself (e.g. "Item Count: 5"), not a count you compute from lineItems. Null if the receipt does not print one.' },
    date: { type: ['string', 'null'], description: 'Purchase date as YYYY-MM-DD. Null if not legible.' },
    subtotal: { type: ['number', 'null'], description: 'Total before tax, plain number. Null if the receipt does not print one.' },
    tax: {
      type: ['number', 'null'],
      description: 'Total tax charged, plain number. Null if genuinely not printed anywhere. ' +
        'If the receipt breaks tax into more than one line (e.g. separate "GST" and "HST" ' +
        'amounts, common on Canadian fuel receipts, sometimes printed as "GST included in ' +
        'fuel $X" / "HST included in fuel $Y" AFTER the total rather than before it), add ' +
        'them together into this one number -- do not report just one of them.',
    },
    tip: { type: ['number', 'null'], description: 'Tip or gratuity, plain number. Null if not printed.' },
    taxLabel: { type: ['string', 'null'], description: 'The tax\'s own printed label and rate, e.g. "HST 13%", "GST 5%", "Sales Tax 8.25%". This is separate from taxNumber below -- taxLabel is what the tax is CALLED and its rate; taxNumber is the merchant\'s registration number. If more than one tax line was summed into the tax field above, join their labels, e.g. "GST 5% + PST 7%". Null if the receipt does not print a rate/label next to the tax amount.' },
    total: { type: ['number', 'null'], description: 'The final amount paid, plain number. Null if not legible.' },
    currency: { type: ['string', 'null'], description: 'Three-letter code if the receipt makes it clear (CAD, USD). Null if it does not.' },
    taxNumber: { type: ['string', 'null'], description: "The merchant's PRIMARY tax registration number exactly as printed, including its label (e.g. 'GST/HST 137466199 RT 0001'). The caller displays this value as-is with no label of its own added -- leaving the label out would show a bare number with no context, and a wrong label (e.g. assuming GST/HST when the receipt actually printed a VAT or ABN number) would misdescribe it. Null if absent." },
    taxNumber2: { type: ['string', 'null'], description: "A SECOND tax registration number, if the receipt prints one, exactly as printed with its label (e.g. 'QST 1016551356 TQ 0001'). Canadian receipts often show GST/HST and QST or PST together. Null if there is only one." },
    buyerName: { type: ['string', 'null'], description: "The customer's or purchaser's name, if the receipt prints one (common on invoices, rare on retail till receipts). Not the merchant's name. Null if absent." },
    time: { type: ['string', 'null'], description: "Time of day exactly as printed, e.g. '18:42:29' or '6:42 PM'. Null if not shown." },
    paymentMethod: { type: ['string', 'null'], description: 'Exactly what the receipt prints for how it was paid, e.g. "Visa •••• 6123" or "Cash". Null if not shown.' },
    paymentReferenceNumber: { type: ['string', 'null'], description: 'The card payment\'s own reference/approval/authorization number, if printed separately from the card brand and last-4 digits (e.g. a line reading "Reference Number: 456" or "Auth Code: 041992"). Not the store\'s receipt/transaction number -- that goes in receiptNumber below. Null if not shown.' },
    receiptNumber: { type: ['string', 'null'], description: "The store's own receipt/transaction/reference number, exactly as printed, including its own printed label (e.g. 'TRANS #: 716634'). The caller displays this value as-is with no label of its own added, so leaving the label out would show a bare number with no context. Null if absent." },
    isPreauth: {
      type: ['boolean', 'null'],
      description: 'True only if the receipt is explicitly marked as a pre-authorization -- ' +
        'text like "PREAUTH RECEIPT ONLY" or "PRE-AUTHORIZATION", common on gas-pump ' +
        'receipts where the printed amount is a hold, not necessarily the final charge. ' +
        'False or null for an ordinary, final receipt -- do not guess this from context, ' +
        'only from an explicit preauth marking actually printed on the paper.',
    },
    // The allowed values live in the description, not an `enum`: a strict
    // schema rejects an enum of strings on a ['string','null'] field. Anything
    // off-list is turned into null when the result is validated below.
    category: {
      type: ['string', 'null'],
      description: `Best-fitting spending category. Must be exactly one of: ${CATEGORIES.join(', ')}. Null if none fit.`,
    },
    lineItems: {
      type: 'array',
      description: 'Individual purchased items as printed. Empty array if not legible.',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          amount: { type: 'number' },
          quantity: { type: ['integer', 'null'], description: 'The printed quantity for this line, e.g. the "2" in "2  2 Dips Special". Null if the receipt shows no quantity or it is 1 and not printed.' },
          subItems: {
            type: ['array', 'null'],
            description: 'Sub-lines printed under this item with no price of their own -- modifiers, ingredients, or included components (e.g. under "2 Dips Special": "Caesar Dip", "Creamy Garlic Caesar Dip"). Null or empty if the item has none.',
            items: { type: 'string' },
          },
        },
        required: ['description', 'amount', 'quantity', 'subItems'],
        additionalProperties: false,
      },
    },
  },
  required: ['merchantName', 'merchantAddress', 'merchantPhone', 'cashierName', 'itemCount', 'date',
             'time', 'subtotal', 'tax', 'taxLabel', 'tip', 'total', 'currency', 'taxNumber',
             'taxNumber2', 'buyerName', 'paymentMethod', 'paymentReferenceNumber', 'receiptNumber',
             'isPreauth', 'category', 'lineItems'],
  additionalProperties: false,
};

const INSTRUCTIONS = `This is a photo of a purchase receipt. Read it for a personal expense wallet and record every field the receipt actually prints.

Rules that matter more than completeness:
- Never guess. If a field is not printed, or is not legible in this photo, use null. A null is useful; a wrong number is not.
- date is one of the two fields this app cannot function without (the other is total) -- look specifically for a printed date near the top or bottom of the receipt before concluding there isn't one. It is not optional just because it's easy to miss next to a time stamp.
- Amounts are plain numbers with no currency symbol (42.17, not "$42.17").
- subtotal, tax and tip are only what the receipt itself shows as separate lines. Do not calculate them from the total. This does NOT mean report only the first tax line you see: if tax is split across more than one printed line (e.g. separate GST and HST amounts, or a line reading "tax included" printed after the total instead of before it -- common on gas-pump receipts), add every such line together into the single tax value. Reading and summing what's printed is not the same as calculating a number that isn't printed.
- taxNumber is the merchant's registration number (GST/HST, VAT, ABN, QST, PST). It is not the receipt or transaction number. Keep the label with the number, so it is clear which tax it is.
- If the receipt prints TWO registration numbers, put the federal/primary one in taxNumber and the provincial/second one in taxNumber2. Do not merge them into one field.
- receiptNumber keeps its own printed label too (e.g. "TRANS #: 716634"), same reasoning as taxNumber.
- buyerName is the person or company who BOUGHT, never the store. Most till receipts do not print one; leave it null rather than repeating the merchant.
- time is copied as printed. Do not convert it, and do not infer a timezone.
- isPreauth is true only for an explicit printed marking like "PREAUTH RECEIPT ONLY" -- never inferred from the merchant type or line items alone.
- taxLabel is what the tax is CALLED and its rate (e.g. "HST 13%"), read from right next to the tax amount. taxNumber is a completely different thing -- the merchant's own tax registration number, often printed elsewhere on the receipt. Do not confuse the two or copy one into the other.
- itemCount is only the number the receipt itself prints as a count (e.g. "Item Count: 5") -- never computed by counting lineItems yourself.
- paymentReferenceNumber is the payment's own reference/approval/authorization number, printed near the card brand and last-4 digits but as its own line. Do not reuse the card's last 4 digits or the receiptNumber for this.
- For each line item, quantity is only set when the receipt prints one next to that item; leave it null rather than assuming 1. subItems are lines printed under an item with no price of their own (modifiers, included components) -- leave null or empty when there are none, and never invent one that isn't printed.
- If this is not a receipt at all, set merchantName to null.`;

// Money on receipts is decimal; everything in this project is stored in cents.
function toCents(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value * 100)
    : null;
}

function cleanString(value, max) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

/**
 * Extracts receipt data from an uploaded image file.
 * Returns the field set above (money in cents) or null on any failure —
 * missing API key, unreadable image, a photo that isn't a receipt — and
 * callers should treat null as "let the customer fill this in by hand."
 */
/**
 * @param source  a Buffer (uploads are held in memory now, see
 *                lib/fileStorage.js) or a path, for any caller that still has
 *                one on disk.
 */
async function extractReceiptData(source, mimetype) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[scan-receipt] ANTHROPIC_API_KEY not set, skipping extraction');
    return null;
  }

  try {
    const base64 = Buffer.isBuffer(source)
      ? source.toString('base64')
      : fs.readFileSync(source).toString('base64');

    const response = await anthropic.messages.create({
      model: 'claude-opus-5',
      max_tokens: 2000, // room for line items; the old 500 truncated longer receipts
      // Reading printed fields off a photo is a perception task, not a
      // reasoning one -- at the default effort this took 26 seconds, which is
      // a long time to hold someone on a spinner right after they take a
      // photo. Low effort answers in a fraction of that with no loss on a task
      // where the answer is either legible or it isn't.
      output_config: { effort: 'low' },
      tools: [
        {
          name: 'record_receipt',
          description: 'Record every field printed on the photographed receipt.',
          strict: true,
          input_schema: RECEIPT_SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: 'record_receipt' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimetype, data: base64 } },
            { type: 'text', text: INSTRUCTIONS },
          ],
        },
      ],
    });

    const call = response.content.find((block) => block.type === 'tool_use');
    if (!call) return null;
    const parsed = call.input;

    if (!parsed.merchantName) return null; // not a receipt, or nothing usable

    return {
      merchantName: cleanString(parsed.merchantName, 200),
      merchantAddress: cleanString(parsed.merchantAddress, 200),
      merchantPhone: cleanString(parsed.merchantPhone, 40),
      cashierName: cleanString(parsed.cashierName, 100),
      itemCount: typeof parsed.itemCount === 'number' && Number.isInteger(parsed.itemCount) && parsed.itemCount >= 0
        ? parsed.itemCount
        : null,
      date: parsed.date && !Number.isNaN(Date.parse(parsed.date)) ? parsed.date : null,
      subtotalCents: toCents(parsed.subtotal),
      taxCents: toCents(parsed.tax),
      taxLabel: cleanString(parsed.taxLabel, 60),
      tipCents: toCents(parsed.tip),
      totalCents: toCents(parsed.total),
      // Three letters, uppercased -- anything else is a misread.
      currency: /^[A-Za-z]{3}$/.test(parsed.currency || '') ? parsed.currency.toUpperCase() : null,
      taxNumber: cleanString(parsed.taxNumber, 40),
      taxNumber2: cleanString(parsed.taxNumber2, 40),
      buyerName: cleanString(parsed.buyerName, 200),
      // Kept as the text the receipt printed, not parsed into a Date: the
      // paper never says which timezone it means.
      timeText: cleanString(parsed.time, 20),
      paymentMethod: cleanString(parsed.paymentMethod, 60),
      paymentReferenceNumber: cleanString(parsed.paymentReferenceNumber, 60),
      receiptNumber: cleanString(parsed.receiptNumber, 60),
      // Shown as a one-time warning on the review screen, never persisted --
      // its only job is making sure the customer notices the total might not
      // be final before they save it, not tracking preauth status forever.
      isPreauth: parsed.isPreauth === true,
      category: CATEGORIES.includes(parsed.category) ? parsed.category : null,
      lineItems: Array.isArray(parsed.lineItems)
        ? parsed.lineItems.slice(0, 50).map((item) => ({
            description: cleanString(item.description, 200) || '',
            amount: typeof item.amount === 'number' && Number.isFinite(item.amount) ? item.amount : 0,
            quantity: typeof item.quantity === 'number' && Number.isInteger(item.quantity) && item.quantity > 0
              ? item.quantity
              : null,
            subItems: Array.isArray(item.subItems)
              ? item.subItems.map((s) => cleanString(s, 200)).filter(Boolean).slice(0, 20)
              : [],
          }))
        : [],
    };
  } catch (err) {
    console.error('[scan-receipt] extraction failed:', err.message);
    return null; // caller falls back to a blank review form
  }
}

module.exports = { extractReceiptData };
