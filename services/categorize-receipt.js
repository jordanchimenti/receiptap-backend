// services/categorize-receipt.js
// The real "Stub" vision: structured line-item data (not photo OCR) gives
// this a genuine accuracy edge over competitors like Expensify, since the
// model gets clean merchant name + itemized data instead of a blurry photo.
//
// This is best-effort and must NEVER block or fail the save/claim flow it's
// called from — a categorization failure should be invisible to the customer.

const Anthropic = require('@anthropic-ai/sdk');
const prisma = require('../lib/prisma');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CATEGORIES = [
  'Food & Drink', 'Groceries', 'Office Supplies', 'Hardware & Tools',
  'Clothing & Apparel', 'Electronics', 'Health & Personal Care',
  'Home & Garden', 'Automotive', 'Entertainment', 'Travel', 'Other',
];

/**
 * Categorizes a single transaction using the merchant name and line items.
 * Returns { category, reasoning } or null on any failure -- callers should
 * treat null as "skip categorization for now," not an error.
 *
 * Deliberately does NOT answer tax deductibility. See the note at the top of
 * lib/receiptDeductible.js: the model can say what was bought, not whether a
 * particular person is entitled to claim it.
 */
async function categorizeTransaction({ merchantName, lineItems }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[categorize-receipt] ANTHROPIC_API_KEY not set, skipping categorization');
    return null;
  }

  const itemsSummary = lineItems.map((i) => `${i.quantity}x ${i.name}`).join(', ');

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
{"category": one of [${CATEGORIES.map((c) => `"${c}"`).join(', ')}], "reasoning": "one short sentence on why this category fits"}

Categorise what was BOUGHT. Do not judge whether it is tax deductible: that
depends on who is filing, what the purchase was for, and where they file,
none of which is on the receipt. The customer decides which of their own
categories count as deductible.`,
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

    return {
      category: parsed.category,
      reasoning: String(parsed.reasoning || '').slice(0, 300),
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
      return prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          aiCategory: result.category,
          aiReasoning: result.reasoning,
          aiCategorizedAt: new Date(),
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
      return prisma.scannedReceipt.update({
        where: { id: scannedReceipt.id },
        data: {
          ...(scannedReceipt.aiCategory ? {} : { aiCategory: result.category }),
          aiReasoning: result.reasoning,
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
