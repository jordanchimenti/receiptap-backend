// services/warrantyReminderService.js
// Daily scan for receipts whose estimated warranty is about to expire,
// firing an in-app + email reminder at two fixed points -- 14 days out, then
// 3 days out (services/notificationService.js's notifyWarrantyExpiring).
// Each stage dedupes independently via its own
// warranty{14d,3d}ReminderSentAt column, so a daily tick can never
// double-send either one, and a receipt whose warranty is corrected later
// (routes/customer-account.js's override route) gets both flags cleared and
// is eligible again against the new date.
//
// Same dryRun-by-default shape as services/dataRetentionService.js -- this
// module never sends for real by itself; the caller (server.js) has to pass
// { dryRun: false } on purpose.

const prisma = require('../lib/prisma');
const { notifyWarrantyExpiring } = require('./notificationService');

const STAGES = [
  { key: '14d', days: 14, field: 'warranty14dReminderSentAt' },
  { key: '3d', days: 3, field: 'warranty3dReminderSentAt' },
];

// A one-day-wide window, not "expires within N days" -- an open-ended range
// would re-match every receipt already inside the 3-day window on every tick
// once it's also inside the 14-day one, and a single instant cutoff would
// let a receipt fall between two daily ticks and never match either. UTC to
// agree with how warrantyExpiresAt itself is computed.
function windowFor(days) {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + days);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

async function sendDueWarrantyReminders({ dryRun = true } = {}) {
  const details = { transactionsNotified: 0, scannedNotified: 0 };
  let error = null;

  try {
    for (const stage of STAGES) {
      const { start, end } = windowFor(stage.days);

      const dueTransactions = await prisma.transaction.findMany({
        where: {
          customerId: { not: null }, // only claimed receipts have anyone to notify
          warrantyExpiresAt: { gte: start, lt: end },
          [stage.field]: null,
        },
        include: { merchant: true },
      });
      for (const t of dueTransactions) {
        if (!dryRun) {
          await notifyWarrantyExpiring({
            customerId: t.customerId,
            merchantName: t.merchant.businessName,
            totalCents: t.total,
            expiresAt: t.warrantyExpiresAt,
            linkUrl: `/receipt/${t.id}`,
            stage: stage.key,
          });
          await prisma.transaction.update({ where: { id: t.id }, data: { [stage.field]: new Date() } });
        }
        details.transactionsNotified += 1;
      }

      const dueScanned = await prisma.scannedReceipt.findMany({
        where: {
          warrantyExpiresAt: { gte: start, lt: end },
          [stage.field]: null,
        },
      });
      for (const r of dueScanned) {
        if (!dryRun) {
          await notifyWarrantyExpiring({
            customerId: r.customerId,
            merchantName: r.merchantName,
            totalCents: r.total,
            expiresAt: r.warrantyExpiresAt,
            linkUrl: `/account/receipts/scanned/${r.id}`,
            stage: stage.key,
          });
          await prisma.scannedReceipt.update({ where: { id: r.id }, data: { [stage.field]: new Date() } });
        }
        details.scannedNotified += 1;
      }
    }
  } catch (err) {
    error = err.message;
    console.error('[warrantyReminderService] sendDueWarrantyReminders failed:', err);
  }

  return { details, error };
}

module.exports = { sendDueWarrantyReminders };
