// services/generateTaxExportPDF.js
//
// A customer's tax export as a formatted, printable PDF -- the same rows
// the CSV export sends (routes/customer-account.js's buildExportRows),
// laid out as a table an accountant can open and read directly rather than
// data they have to import into a spreadsheet first. Same
// render-HTML-then-Playwright-PDF approach as
// services/generate-receipt-pdf.js, just a table template instead of the
// receipt template, and a fixed Letter page (paginated by the browser) since
// an export can run to many rows, unlike a single receipt.

const ejs = require('ejs');
const path = require('path');
const { chromium } = require('playwright');

const VIEWS_DIR = path.join(__dirname, '..', 'views');

async function generateTaxExportPDF(data) {
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'tax-export-pdf.ejs'), data, { views: [VIEWS_DIR] });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    return await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.6in', bottom: '0.6in', left: '0.5in', right: '0.5in' },
    });
  } finally {
    await browser.close();
  }
}

module.exports = { generateTaxExportPDF };
