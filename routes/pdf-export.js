// routes/pdf-export.js
// Bulk PDF export: actual receipt DOCUMENT copies (not just spreadsheet
// data) for a merchant's own records or their accountant/bookkeeper.
// Separate from the CSV export on the same page, which is transaction
// data rows, not formatted documents.

const express = require('express');
const router = express.Router();
const archiver = require('archiver');
const { PrismaClient } = require('@prisma/client');
const { generateReceiptPDFs } = require('../services/generate-receipt-pdf');

const prisma = new PrismaClient();

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

  const transactions = await prisma.transaction.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: MAX_PDF_EXPORT,
  });

  if (transactions.length === 0) {
    return res.status(404).send('No receipts found in that date range.');
  }

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
