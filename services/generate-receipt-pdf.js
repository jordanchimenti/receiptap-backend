// services/generate-receipt-pdf.js
// Renders a transaction to an actual PDF document — reuses the EXACT same
// receipt.ejs template (theme, chosen layout, branding) that customers see
// live, so the PDF a merchant keeps for their records looks identical to
// what was actually delivered. No separate PDF-specific template to maintain.

const ejs = require('ejs');
const path = require('path');
const { chromium } = require('playwright');
const { SHOPPER_CONSENT } = require('../config/legal');
const { resolveSellerForRender } = require('../lib/receiptSnapshot');

const VIEWS_DIR = path.join(__dirname, '..', 'views');

function formatTransactionForTemplate(transaction) {
  return {
    ...transaction,
    subtotal: (transaction.subtotal / 100).toFixed(2),
    tax: (transaction.tax / 100).toFixed(2),
    total: (transaction.total / 100).toFixed(2),
    date: transaction.createdAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
  };
}

async function renderReceiptHTML(transaction, merchant, theme) {
  const safeTheme = theme || { layoutId: 'classic', primaryColor: '#111111', accentColor: '#2563eb', showWalletSave: false };
  // receipt.ejs no longer resolves this itself -- every caller must, since
  // the receipt_seller_snapshot migration (lib/receiptSnapshot.js). This is
  // always a real, persisted transaction (a merchant's own past sale), never
  // synthetic, so it must carry its own seller* snapshot -- resolveSellerForRender
  // throws loudly if it doesn't, rather than silently reviving the live join
  // this migration exists to remove.
  const seller = resolveSellerForRender(transaction, { theme: safeTheme, merchant });
  return ejs.renderFile(
    path.join(VIEWS_DIR, 'receipt.ejs'),
    {
      merchant,
      theme: safeTheme,
      seller,
      googleClientId: '', // no need for a live Google button inside a static PDF
      isMerchantCopy: true, // a merchant's own saved PDF -- referenced unguarded elsewhere in receipt.ejs
      shopperConsentText: SHOPPER_CONSENT,
      transaction: formatTransactionForTemplate(transaction),
    },
    { views: [VIEWS_DIR] }
  );
}

/**
 * Generates PDFs for multiple transactions efficiently by reusing ONE
 * browser instance across all of them, rather than launching a fresh
 * browser per receipt (which would be very slow for a bulk export).
 * Returns an array of { transactionId, buffer }.
 */
async function generateReceiptPDFs(transactions, merchant, theme) {
  const browser = await chromium.launch();
  const results = [];

  try {
    const page = await browser.newPage();
    for (const transaction of transactions) {
      const html = await renderReceiptHTML(transaction, merchant, theme);
      await page.setContent(html, { waitUntil: 'networkidle' });

      // Size the PDF page to the actual rendered content height, like a real
      // receipt printer would — not a fixed Letter/A4 page with a short
      // receipt floating in a sea of blank space below it.
      const contentHeight = await page.evaluate(() => document.body.scrollHeight);

      const buffer = await page.pdf({
        width: '480px',
        height: `${contentHeight + 40}px`, // + a little breathing room
        printBackground: true,
        margin: { top: '20px', bottom: '20px', left: '0', right: '0' },
      });
      results.push({ transactionId: transaction.id, buffer });
    }
  } finally {
    await browser.close(); // always close, even if one receipt fails mid-batch
  }

  return results;
}

module.exports = { generateReceiptPDFs };
