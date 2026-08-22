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
 * Returns { category, taxDeductible, reasoning } or null on any failure —
 * callers should treat null as "skip categorization for now," not an error.
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
          content: `Classify this purchase for personal/business expense tracking.

Merchant: ${merchantName}
Items: ${itemsSummary}

Respond with ONLY a JSON object, no other text, in this exact shape:
{"category": one of [${CATEGORIES.map((c) => `"${c}"`).join(', ')}], "taxDeductible": true|false, "reasoning": "one short sentence explaining the tax deductibility call"}

"taxDeductible" should reflect whether this purchase COULD plausibly be a legitimate business expense (be moderate, not aggressive — e.g. a laptop from an electronics store: true; a birthday gift or entertainment for personal use: false). This is a helpful suggestion for the user's own records, not tax advice.`,
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
      taxDeductible: Boolean(parsed.taxDeductible),
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
          aiTaxDeductible: result.taxDeductible,
          aiReasoning: result.reasoning,
          aiCategorizedAt: new Date(),
        },
      });
    })
    .catch((err) => console.error('[categorize] background categorization failed:', err.message));
}

module.exports = { categorizeTransaction, categorizeInBackground, CATEGORIES };
