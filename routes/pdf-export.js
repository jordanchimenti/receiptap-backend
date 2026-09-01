// routes/pdf-export.js
// Bulk PDF export: actual receipt DOCUMENT copies (not just spreadsheet
// data) for a merchant's own records or their accountant/bookkeeper.
// Separate from the CSV export on the same page, which is transaction
// data rows, not formatted documents.

const express = require('express');
const router = express.Router();
const archiver = require('archiver');
const { generateReceiptPDFs } = require('../services/generate-receipt-pdf');
const prisma = require('../lib/prisma');

function requireAuth(req, res, next) {
  if (!req.session?.merchantId) return res.redirect('/login');
  next();
}

const MAX_PDF_EXPORT = 200; // guardrail — a huge date range could otherwise take a very long time to render

router.get('/dashboard/receipts/pdf-export', requireAuth, async (req, res) => {
  const { from, to } = req.query;

  const merchant = await prisma.merchant.findUnique({ where: { id: req.session.merchantId } });
  const theme = await prisma.receiptTheme.findUnique({ where: { merchantId: req.session.merchantId } });

  const where = {
    merchantId: req.session.merchantId,
    ...(from || to
      ? {
          createdAt: {
            ...(from ? { gte: new Date(from) } : {}),
            ...(to ? { lte: new Date(new Date(to).setHours(23, 59, 59, 999)) } : {}),
          },
        }
      : {}),
  };

  // Counted separately from the fetch below (which is capped) so the
  // rejection message can say the real number instead of just "over 200" --
  // and so a range that matches exactly 200 isn't wrongly treated as an
  // overflow. Previously this route fetched with `take: MAX_PDF_EXPORT` and
  // said nothing else: a merchant pulling records for their own bookkeeping
  // or an audit had no way to know their export was silently incomplete.
  // Bulk PDF generation is expensive (a real Playwright render per receipt,
  // see generateReceiptPDFs), so this rejects and asks for a narrower range
  // rather than truncating -- same reasoning the MAX_PDF_EXPORT guardrail
  // itself already states.
  const matchingCount = await prisma.transaction.count({ where });

  if (matchingCount === 0) {
    return res.status(404).send('No receipts found in that date range.');
  }

  if (matchingCount > MAX_PDF_EXPORT) {
    return res
      .status(400)
      .send(
        `This date range matches ${matchingCount} receipts, which is more than the ${MAX_PDF_EXPORT}-receipt export limit. ` +
          'Narrow the date range and try again.'
      );
  }

  const transactions = await prisma.transaction.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: MAX_PDF_EXPORT,
  });

  let pdfs;
  try {
    pdfs = await generateReceiptPDFs(transactions, merchant, theme);
  } catch (err) {
    console.error('[pdf-export] PDF generation failed:', err.message);
    return res.status(500).send('Failed to generate receipt PDFs. Please try again or narrow the date range.');
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="receiptap-receipts.zip"');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('[pdf-export] archive error:', err.message);
    res.status(500).end();
  });
  archive.pipe(res);

  for (const { transactionId, buffer } of pdfs) {
    archive.append(buffer, { name: `receipt-${transactionId}.pdf` });
  }

  await archive.finalize();
});

module.exports = router;
