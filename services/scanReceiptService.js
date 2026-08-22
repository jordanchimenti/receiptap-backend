// services/scanReceiptService.js
// Reads a photographed/uploaded receipt image and extracts merchant name,
// date, total, and line items via Claude's vision support. Unlike
// categorize-receipt.js's fire-and-forget best-effort categorization, this
// is called synchronously and its result is shown to the customer for
// review/correction before anything is saved -- so a failure here doesn't
// get silently dropped the same way; the caller falls back to a blank
// review form instead.

const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { CATEGORIES } = require('./categorize-receipt');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Extracts receipt data from an uploaded image file.
 * Returns { merchantName, date, totalCents, lineItems, category,
 * paymentMethod, receiptNumber } or null on any failure (missing API key,
 * unreadable image, malformed response) — callers should treat null as
 * "let the customer fill this in by hand." paymentMethod/receiptNumber are
 * only ever what's actually printed on the receipt (e.g. "Visa •••• 6123",
 * a store's own transaction number) — never fabricated, null if the photo
 * doesn't show one.
 */
async function extractReceiptData(filePath, mimetype) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[scan-receipt] ANTHROPIC_API_KEY not set, skipping extraction');
    return null;
  }

  try {
    const base64 = fs.readFileSync(filePath).toString('base64');

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimetype, data: base64 } },
            {
              type: 'text',
              text: `This is a photo of a purchase receipt. Extract its details for a personal expense wallet.

Respond with ONLY a JSON object, no other text, in this exact shape:
{"merchantName": "the store or business name", "date": "YYYY-MM-DD or null if not legible", "total": the final total paid as a plain number (e.g. 42.17, no currency symbol) or null if not legible, "lineItems": [{"description": "...", "amount": 0.00}], "category": one of [${CATEGORIES.map((c) => `"${c}"`).join(', ')}], "paymentMethod": "exactly what the receipt itself prints for how it was paid, e.g. \\"Visa •••• 6123\\" or \\"Cash\\" or \\"Debit\\" -- or null if the receipt doesn't show one, never guessed", "receiptNumber": "the store's own printed receipt/transaction/reference number, exactly as shown, or null if there isn't one"}

If this doesn't look like a receipt at all, or a field genuinely isn't legible, use null for that field rather than guessing. Only fill in paymentMethod or receiptNumber if the receipt actually prints them -- do not infer or make one up.`,
            },
          ],
        },
      ],
    });

    const text = response.content.find((block) => block.type === 'text')?.text || '';
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!parsed.merchantName) return null; // nothing usable came back

    return {
      merchantName: String(parsed.merchantName).slice(0, 200),
      date: parsed.date && !Number.isNaN(Date.parse(parsed.date)) ? parsed.date : null,
      totalCents: typeof parsed.total === 'number' ? Math.round(parsed.total * 100) : null,
      lineItems: Array.isArray(parsed.lineItems) ? parsed.lineItems.slice(0, 50) : [],
      category: CATEGORIES.includes(parsed.category) ? parsed.category : null,
      paymentMethod: typeof parsed.paymentMethod === 'string' && parsed.paymentMethod.trim() ? parsed.paymentMethod.trim().slice(0, 60) : null,
      receiptNumber: typeof parsed.receiptNumber === 'string' && parsed.receiptNumber.trim() ? parsed.receiptNumber.trim().slice(0, 60) : null,
    };
  } catch (err) {
    console.error('[scan-receipt] extraction failed:', err.message);
    return null; // caller falls back to a blank review form
  }
}

module.exports = { extractReceiptData };
