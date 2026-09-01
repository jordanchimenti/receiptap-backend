// services/categorize-receipt.js
// The real "Stub" vision: structured line-item data (not photo OCR) gives
// this a genuine accuracy edge over competitors like Expensify, since the
// model gets clean merchant name + itemized data instead of a blurry photo.
//
// This is best-effort and must NEVER block or fail the save/claim flow it's
// called from — a categorization failure should be invisible to the customer.

const Anthropic = require('@anthropic-ai/sdk');
const prisma = require('../lib/prisma');
const { computeWarrantyExpiry, effectiveWarrantyMonths } = require('../lib/receiptWarranty');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CATEGORIES = [
  'Food & Drink', 'Groceries', 'Office Supplies', 'Hardware & Tools',
  'Clothing & Apparel', 'Electronics', 'Health & Personal Care',
  'Home & Garden', 'Automotive', 'Entertainment', 'Travel', 'Other',
];

/**
 * Categorizes a single transaction using the merchant name and line items.
 * Returns { category, reasoning, warrantyMonths } or null on any failure --
 * callers should treat null as "skip categorization for now," not an error.
 *
 * Deliberately does NOT answer tax deductibility. See the note at the top of
 * lib/receiptDeductible.js: the model can say what was bought, not whether a
 * particular person is entitled to claim it. Warranty length is different --
 * a typical manufacturer/store warranty is a fact about the product, not the
 * buyer's circumstances, so the model IS allowed to estimate it directly (see
 * lib/receiptWarranty.js for how a customer's own correction still wins).
 *
 * lineItems accepts either shape this app stores: a tapped Transaction's
 * `{ name, quantity, unitPrice, total }` (from the POS) or a scanned
 * ScannedReceipt's `{ description, amount, quantity, subItems }` (from the AI
 * extraction pass, see services/scanReceiptService.js) -- the two were never
 * unified into one shape, so this reads whichever label field the item
 * actually has instead of assuming `name`.
 */
async function categorizeTransaction({ merchantName, lineItems }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[categorize-receipt] ANTHROPIC_API_KEY not set, skipping categorization');
    return null;
  }

  const itemsSummary = lineItems
    .map((i) => {
      const label = i.name || i.description;
      if (!label) return null;
      return i.quantity ? `${i.quantity}x ${label}` : label;
    })
    .filter(Boolean)
    .join(', ');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: `Categorise this purchase for expense tracking.

Merchant: ${merchantName}
Items: ${itemsSummary}

Respond with ONLY a JSON object, no other text, in this exact shape:
{"category": one of [${CATEGORIES.map((c) => `"${c}"`).join(', ')}], "reasoning": "one short sentence on why this category fits", "warrantyMonths": integer or null}

Categorise what was BOUGHT. Do not judge whether it is tax deductible: that
depends on who is filing, what the purchase was for, and where they file,
none of which is on the receipt. The customer decides which of their own
categories count as deductible.

"warrantyMonths": your best estimate, in whole months, of the typical
manufacturer or store warranty for this purchase (e.g. 12 for a standard
one-year electronics warranty, 24 for many appliances). Use null for
anything that doesn't typically carry one -- food, groceries, travel,
entertainment, services, or apparel with no specific product warranty. If a
line item itself names a protection plan or extended warranty (e.g.
"AppleCare", "2-Year Protection Plan"), use that plan's length instead of
guessing the base manufacturer term.`,
        },
      ],
    });

    const text = response.content.find((block) => block.type === 'text')?.text || '';
    // Defensive: models sometimes wrap JSON in ```json fences despite instructions not to
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!CATEGORIES.includes(parsed.category)) {
      parsed.category = 'Other';
    }

    // Anything other than a positive whole number means "no typical
    // warranty" -- including a model that ignores the null instruction and
    // sends a string, 0, or a fraction.
    const warrantyMonths =
      Number.isInteger(parsed.warrantyMonths) && parsed.warrantyMonths > 0 ? parsed.warrantyMonths : null;

    return {
      category: parsed.category,
      reasoning: String(parsed.reasoning || '').slice(0, 300),
      warrantyMonths,
    };
  } catch (err) {
    console.error('[categorize-receipt] categorization failed:', err.message);
    return null; // caller proceeds without categorization — never blocks the save flow
  }
}

/**
 * Fire-and-forget categorisation: kicks off the AI call and writes the result
 * when it lands, without making the caller wait. Every path that saves a
 * receipt wants this, so it lives here rather than being redefined per route
 * -- it existed as two identical private copies in routes/customer-account.js
 * and routes/email-capture.js, which is how a third caller ended up importing
 * a name this module never exported.
 *
 * Best-effort by design: a failed categorisation leaves the ai* fields null
 * and is never retried, rather than blocking or failing the save.
 */
function categorizeInBackground(transaction, merchantName) {
  categorizeTransaction({ merchantName, lineItems: transaction.lineItems })
    .then((result) => {
      if (!result) return;
      // Transaction has no separate purchase-date column -- createdAt IS the
      // purchase moment, since the webhook that creates the row fires at
      // sale time (see lib/receiptDateLabels.js).
      //
      // warrantyExpiresAt is keyed to whichever number is EFFECTIVE, not
      // just this fresh AI estimate -- categorizeInBackground only runs once
      // per receipt (guarded by aiCategorizedAt at every call site), so a
      // customer override normally can't exist yet, but if one somehow does
      // (a race with the override route) it must keep governing the stored
      // expiry rather than being silently overwritten by the AI's guess.
      const months = effectiveWarrantyMonths({ aiWarrantyMonths: result.warrantyMonths, warrantyMonths: transaction.warrantyMonths });
      return prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          aiCategory: result.category,
          aiReasoning: result.reasoning,
          aiCategorizedAt: new Date(),
          aiWarrantyMonths: result.warrantyMonths,
          warrantyExpiresAt: computeWarrantyExpiry(transaction.createdAt, months),
        },
      });
    })
    .catch((err) => console.error('[categorize] background categorization failed:', err.message));
}

/**
 * The same fire-and-forget pass for a receipt the customer photographed.
 *
 * Scanned receipts were categorised at extraction time but never assessed for
 * deductibility -- ScannedReceipt simply had no column for it -- so half a
 * customer's wallet could never appear in a tax export. Same contract as
 * categorizeInBackground: best-effort, never blocks or fails the save.
 *
 * Writes aiCategory only when the extraction pass didn't already produce one:
 * that read the actual photo, so it saw more than a merchant name and a list
 * of items and shouldn't be second-guessed here.
 */
function categorizeScannedInBackground(scannedReceipt) {
  categorizeTransaction({
    merchantName: scannedReceipt.merchantName,
    lineItems: Array.isArray(scannedReceipt.lineItems) ? scannedReceipt.lineItems : [],
  })
    .then((result) => {
      if (!result) return;
      // purchaseDate is the true purchase date for a scanned receipt (typed
      // in by the customer); createdAt (the upload time) is only the
      // fallback for the receipts old enough not to have one. Same
      // effective-months precedence as categorizeInBackground above.
      const months = effectiveWarrantyMonths({ aiWarrantyMonths: result.warrantyMonths, warrantyMonths: scannedReceipt.warrantyMonths });
      return prisma.scannedReceipt.update({
        where: { id: scannedReceipt.id },
        data: {
          ...(scannedReceipt.aiCategory ? {} : { aiCategory: result.category }),
          aiReasoning: result.reasoning,
          aiWarrantyMonths: result.warrantyMonths,
          warrantyExpiresAt: computeWarrantyExpiry(scannedReceipt.purchaseDate || scannedReceipt.createdAt, months),
        },
      });
    })
    .catch((err) =>
      console.error('[categorize] background scanned categorization failed:', err.message)
    );
}

module.exports = {
  categorizeTransaction,
  categorizeInBackground,
  categorizeScannedInBackground,
  CATEGORIES,
};
