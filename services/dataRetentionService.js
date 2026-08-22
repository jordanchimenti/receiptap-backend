// services/dataRetentionService.js
// The actual deletion logic behind config/retention.js's windows. Every
// function here defaults to dryRun: true -- it reports what WOULD be
// deleted without touching anything, unless explicitly told not to. This
// module never enables live deletion by itself; something else (the
// scheduled job, or the Part E dashboard action) has to pass
// { dryRun: false } on purpose.
//
// FK order matters and is NOT automatic (confirmed by reading the actual
// migration SQL, not assumed): ShopperConsent.receiptId -> Transaction and
// LoyaltyCard.customerId -> Customer are both ON DELETE RESTRICT, so the
// child rows must be deleted before the parent, every time, or Postgres
// rejects the delete. LegalAcceptance.merchantId -> Merchant is ALSO
// RESTRICT, and deliberately never dealt with here -- see purgeDeactivatedMerchants
// below for why that makes hard-deleting a Merchant row impossible by
// construction, which is exactly what config/retention.js promises for
// LegalAcceptance.
const prisma = require('../lib/prisma');
const fs = require('fs');
const path = require('path');
const {
  SHOPPER_RECEIPT_MONTHS,
  SHOPPER_ACCOUNT_MONTHS,
  DEACTIVATED_MERCHANT_PURGE_DAYS,
} = require('../config/retention');
const { suppressEmail } = require('./emailSuppressionService');

const BATCH_SIZE = 500;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function monthsAgo(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d;
}

function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function sumDetails(details) {
  return Object.values(details).reduce((sum, n) => sum + n, 0);
}

// Best-effort disk cleanup for an uploaded logo/profile-photo -- a missing
// file (already gone, or never existed) is not an error worth failing a
// purge over, so this only ever logs and moves on.
function deleteUploadedFile(webPath) {
  if (!webPath) return;
  try {
    fs.unlinkSync(path.join(PUBLIC_DIR, webPath));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[dataRetentionService] failed to remove uploaded file:', webPath, err.message);
  }
}

async function writePurgeLog({ jobName, dryRun, details, error, initiatedByMerchantId, startedAt }) {
  await prisma.purgeLog.create({
    data: {
      jobName,
      dryRun,
      rowsDeleted: sumDetails(details),
      details,
      error: error || null,
      initiatedByMerchantId: initiatedByMerchantId || null,
      startedAt,
      finishedAt: new Date(),
    },
  });
}

// Repeatedly finds up to BATCH_SIZE row ids matching `findBatch`, deletes
// them via `deleteBatch`, and keeps going until a batch comes back smaller
// than BATCH_SIZE. Used for the flat, potentially-large Transaction purge;
// per-merchant and per-shopper deletes below are already naturally small
// and don't need this.
async function deleteInBatches(findBatchIds, deleteByIds) {
  let total = 0;
  while (true) {
    const ids = await findBatchIds(BATCH_SIZE);
    if (ids.length === 0) break;
    total += await deleteByIds(ids);
    if (ids.length < BATCH_SIZE) break;
  }
  return total;
}

/**
 * Deletes Transaction rows (and their ShopperConsent rows, deleted first --
 * RESTRICT) older than SHOPPER_RECEIPT_MONTHS. Then, separately, deletes
 * any Customer account that's both older than SHOPPER_ACCOUNT_MONTHS and
 * has no transaction newer than the receipt cutoff -- i.e. nothing left
 * keeping the account "active" (LoyaltyCard rows first, same RESTRICT
 * reasoning). Logs one PurgeLog row for the whole run.
 */
async function purgeExpiredReceipts({ dryRun = true } = {}) {
  const startedAt = new Date();
  const receiptCutoff = monthsAgo(SHOPPER_RECEIPT_MONTHS);
  const accountCutoff = monthsAgo(SHOPPER_ACCOUNT_MONTHS);
  const details = { Transaction: 0, ShopperConsent: 0, Customer: 0, LoyaltyCard: 0, ShopperIdentifier: 0 };
  let error = null;

  try {
    if (dryRun) {
      details.Transaction = await prisma.transaction.count({ where: { createdAt: { lt: receiptCutoff } } });
      details.ShopperConsent = await prisma.shopperConsent.count({
        where: { receipt: { createdAt: { lt: receiptCutoff } } },
      });
    } else {
      details.Transaction = await deleteInBatches(
        async (take) => {
          const rows = await prisma.transaction.findMany({
            where: { createdAt: { lt: receiptCutoff } },
            select: { id: true },
            take,
          });
          return rows.map((r) => r.id);
        },
        async (ids) => {
          const [consentResult, txnResult] = await prisma.$transaction([
            prisma.shopperConsent.deleteMany({ where: { receiptId: { in: ids } } }),
            prisma.transaction.deleteMany({ where: { id: { in: ids } } }),
          ]);
          details.ShopperConsent += consentResult.count;
          return txnResult.count;
        }
      );
    }

    // "No transaction newer than receiptCutoff" is true whether or not
    // this run actually deleted those old rows yet -- so this check gives
    // an accurate answer in both dry-run and live mode.
    const idleCustomerIds = (
      await prisma.customer.findMany({
        where: {
          createdAt: { lt: accountCutoff },
          transactions: { none: { createdAt: { gte: receiptCutoff } } },
        },
        select: { id: true },
      })
    ).map((c) => c.id);

    for (let i = 0; i < idleCustomerIds.length; i += BATCH_SIZE) {
      const batch = idleCustomerIds.slice(i, i + BATCH_SIZE);
      if (dryRun) {
        details.LoyaltyCard += await prisma.loyaltyCard.count({ where: { customerId: { in: batch } } });
        details.ShopperIdentifier += await prisma.shopperIdentifier.count({ where: { shopperId: { in: batch } } });
        details.Customer += batch.length;
      } else {
        // ShopperIdentifier.shopperId is ON DELETE RESTRICT, so it has to be
        // cleared before the Customer rows -- without this, this scheduled job
        // starts throwing the first time an idle shopper has a card link.
        const [loyaltyResult, identifierResult, customerResult] = await prisma.$transaction([
          prisma.loyaltyCard.deleteMany({ where: { customerId: { in: batch } } }),
          prisma.shopperIdentifier.deleteMany({ where: { shopperId: { in: batch } } }),
          prisma.customer.deleteMany({ where: { id: { in: batch } } }),
        ]);
        details.LoyaltyCard += loyaltyResult.count;
        details.ShopperIdentifier += identifierResult.count;
        details.Customer += customerResult.count;
      }
    }
  } catch (err) {
    error = err.message;
    console.error('[dataRetentionService] purgeExpiredReceipts failed:', err);
  }

  await writePurgeLog({ jobName: 'purgeExpiredReceipts', dryRun, details, error, startedAt });
  return { details, error };
}

/**
 * For every merchant deactivated (isActive: false) more than
 * DEACTIVATED_MERCHANT_PURGE_DAYS ago and not yet purged: deletes their
 * Transactions (+ dependent ShopperConsent rows), LoyaltyCard rows,
 * LoyaltyProgram row, ReceiptTheme row (+ its logo file), removes the
 * merchant's own profile photo file, and anonymizes the Merchant row's PII
 * fields in place.
 *
 * The Merchant ROW ITSELF is never deleted -- LegalAcceptance.merchantId,
 * ReceiptTheme.merchantId, LoyaltyProgram.merchantId, and Commission.merchantId
 * are all ON DELETE RESTRICT (confirmed in the migration SQL), so Postgres
 * would refuse a hard delete anyway as long as a LegalAcceptance row exists
 * for this merchant -- which, per config/retention.js, it always will,
 * forever. That's what makes "LegalAcceptance survives merchant deletion"
 * true by construction rather than by convention: there IS no merchant
 * deletion, only anonymization, and this function is the only thing in the
 * codebase that performs it.
 */
async function purgeDeactivatedMerchants({ dryRun = true } = {}) {
  const startedAt = new Date();
  const cutoff = daysAgo(DEACTIVATED_MERCHANT_PURGE_DAYS);
  const details = { Merchant: 0, Transaction: 0, ShopperConsent: 0, LoyaltyCard: 0, LoyaltyProgram: 0, ReceiptTheme: 0 };
  let error = null;

  try {
    let candidates;
    do {
      candidates = await prisma.merchant.findMany({
        where: { isActive: false, deactivatedAt: { lt: cutoff }, dataPurgedAt: null },
        select: { id: true, profilePhotoUrl: true },
        take: BATCH_SIZE,
      });

      for (const merchant of candidates) {
        const theme = await prisma.receiptTheme.findUnique({
          where: { merchantId: merchant.id },
          select: { logoUrl: true },
        });
        const txnIds = (
          await prisma.transaction.findMany({ where: { merchantId: merchant.id }, select: { id: true } })
        ).map((t) => t.id);
        const consentCount = await prisma.shopperConsent.count({ where: { receiptId: { in: txnIds } } });
        const loyaltyCardCount = await prisma.loyaltyCard.count({ where: { merchantId: merchant.id } });
        const hasLoyaltyProgram = Boolean(await prisma.loyaltyProgram.findUnique({ where: { merchantId: merchant.id } }));

        if (dryRun) {
          details.Merchant += 1;
          details.Transaction += txnIds.length;
          details.ShopperConsent += consentCount;
          details.LoyaltyCard += loyaltyCardCount;
          details.LoyaltyProgram += hasLoyaltyProgram ? 1 : 0;
          details.ReceiptTheme += theme ? 1 : 0;
          continue;
        }

        await prisma.$transaction([
          prisma.shopperConsent.deleteMany({ where: { receiptId: { in: txnIds } } }),
          prisma.transaction.deleteMany({ where: { merchantId: merchant.id } }),
          prisma.loyaltyCard.deleteMany({ where: { merchantId: merchant.id } }),
          prisma.loyaltyProgram.deleteMany({ where: { merchantId: merchant.id } }),
          prisma.receiptTheme.deleteMany({ where: { merchantId: merchant.id } }),
          prisma.merchant.update({
            where: { id: merchant.id },
            data: {
              email: `deleted-${merchant.id}@purged.receiptap.internal`,
              ownerName: null,
              businessName: 'Deactivated Merchant',
              profilePhotoUrl: null,
              passwordHash: null,
              googleId: null,
              resetToken: null,
              resetTokenExpiresAt: null,
              squareMerchantId: null,
              squareAccessToken: null,
              shopifyShopDomain: null,
              shopifyAccessToken: null,
              cloverMerchantId: null,
              cloverAccessToken: null,
              cloverRefreshToken: null,
              cloverAccessTokenExpiresAt: null,
              stripeCustomerId: null,
              stripeSubscriptionId: null,
              dataPurgedAt: new Date(),
            },
          }),
        ]);

        // Disk isn't transactional and a missing file shouldn't fail the
        // purge -- done after the DB transaction commits.
        deleteUploadedFile(merchant.profilePhotoUrl);
        deleteUploadedFile(theme?.logoUrl);

        details.Merchant += 1;
        details.Transaction += txnIds.length;
        details.ShopperConsent += consentCount;
        details.LoyaltyCard += loyaltyCardCount;
        details.LoyaltyProgram += hasLoyaltyProgram ? 1 : 0;
        details.ReceiptTheme += theme ? 1 : 0;
      }
    } while (!dryRun && candidates.length === BATCH_SIZE); // dry run never mutates dataPurgedAt, so re-querying would just find the same rows forever
  } catch (err) {
    error = err.message;
    console.error('[dataRetentionService] purgeDeactivatedMerchants failed:', err);
  }

  await writePurgeLog({ jobName: 'purgeDeactivatedMerchants', dryRun, details, error, startedAt });
  return { details, error };
}

/**
 * DSAR-style deletion scoped to ONE merchant's relationship with one
 * shopper (by email). Deliberately does NOT delete the merchant's own
 * Transaction rows -- those are the merchant's sale record (amount, items,
 * date), which they may have a legitimate business reason to keep even
 * after a specific person's data is erased. Instead it severs the personal
 * link (customerId -> null, already an existing ON DELETE SET NULL
 * relation) and deletes what IS unambiguously the shopper's own data: their
 * ShopperConsent decisions for those receipts, and their LoyaltyCard at
 * this merchant. The Customer account itself is untouched (they may have a
 * wallet relationship with other merchants too) -- see deleteShopperEverywhere
 * for full-account erasure.
 *
 * ShopperIdentifier rows are deliberately NOT touched here. An identifier is
 * shopper-to-platform, not shopper-to-merchant: one merchant asking to erase
 * their own copy of a shopper's data has no claim over a link that shopper
 * holds with every other ReceipTap business. Deleting it would silently break
 * recognition elsewhere on one merchant's say-so. Full erasure of identifiers
 * belongs to the shopper's own request -- deleteShopperEverywhere.
 */
async function deleteShopperByEmail(email, merchantId, { dryRun = true } = {}) {
  const startedAt = new Date();
  const details = { Transaction_unlinked: 0, ShopperConsent: 0, LoyaltyCard: 0 };
  let error = null;
  let found = false;

  try {
    const customer = await prisma.customer.findUnique({ where: { email: email.toLowerCase() } });
    if (customer) {
      found = true;
      const txnIds = (
        await prisma.transaction.findMany({
          where: { merchantId, customerId: customer.id },
          select: { id: true },
        })
      ).map((t) => t.id);

      const consentCount = await prisma.shopperConsent.count({ where: { receiptId: { in: txnIds } } });
      const loyaltyCard = await prisma.loyaltyCard.findUnique({
        where: { merchantId_customerId: { merchantId, customerId: customer.id } },
      });

      if (dryRun) {
        details.Transaction_unlinked = txnIds.length;
        details.ShopperConsent = consentCount;
        details.LoyaltyCard = loyaltyCard ? 1 : 0;
      } else {
        const ops = [
          prisma.shopperConsent.deleteMany({ where: { receiptId: { in: txnIds } } }),
          prisma.transaction.updateMany({ where: { id: { in: txnIds } }, data: { customerId: null } }),
        ];
        if (loyaltyCard) ops.push(prisma.loyaltyCard.delete({ where: { id: loyaltyCard.id } }));
        const results = await prisma.$transaction(ops);
        details.ShopperConsent = results[0].count;
        details.Transaction_unlinked = results[1].count;
        details.LoyaltyCard = loyaltyCard ? 1 : 0;

        // Survives on purpose -- see EmailSuppression's doc comment in the
        // schema. Written after the delete transaction commits, not inside
        // it: this row's whole reason to exist is to outlive the data that
        // was just removed, so it isn't rolled back with it.
        await suppressEmail({ email, merchantId, reason: 'deletion_requested' });
      }
    }
  } catch (err) {
    error = err.message;
    console.error('[dataRetentionService] deleteShopperByEmail failed:', err);
  }

  await writePurgeLog({
    jobName: 'deleteShopperByEmail',
    dryRun,
    details,
    error,
    initiatedByMerchantId: merchantId,
    startedAt,
  });
  return { found, details, error };
}

/**
 * Full erasure: the same per-transaction unlink + ShopperConsent/LoyaltyCard
 * deletion as deleteShopperByEmail, but across EVERY merchant this shopper
 * has ever transacted with, plus the Customer account itself (email, name,
 * password, Google identity) at the end. Not merchant-scoped -- there is no
 * single merchant who could authorize this alone, since it touches other
 * merchants' data too. initiatedByMerchantId is optional and normally left
 * null (system/admin-initiated); it exists so a future admin-facing caller
 * can still attribute the action if needed.
 */
async function deleteShopperEverywhere(email, { dryRun = true, initiatedByMerchantId = null } = {}) {
  const startedAt = new Date();
  const details = { Transaction_unlinked: 0, ShopperConsent: 0, LoyaltyCard: 0, ScannedReceipt: 0, ShopperIdentifier: 0, Customer: 0 };
  let error = null;
  let found = false;

  try {
    const customer = await prisma.customer.findUnique({ where: { email: email.toLowerCase() } });
    if (customer) {
      found = true;
      const txns = await prisma.transaction.findMany({
        where: { customerId: customer.id },
        select: { id: true, merchantId: true },
      });
      const txnIds = txns.map((t) => t.id);
      // Every merchant this shopper has an existing relationship with needs
      // its own suppression row -- consent is granted per-merchant
      // (see ShopperConsent), so opting out has to be too.
      const merchantIds = [...new Set(txns.map((t) => t.merchantId))];
      const consentCount = await prisma.shopperConsent.count({ where: { receiptId: { in: txnIds } } });
      const loyaltyCardCount = await prisma.loyaltyCard.count({ where: { customerId: customer.id } });
      const scannedReceiptCount = await prisma.scannedReceipt.count({ where: { customerId: customer.id } });
      // Every passive identifier that could still recognise this person --
      // revoked ones included. A revoked row is kept for audit while the
      // shopper exists, but a full erasure means nothing about them survives,
      // so this counts and deletes both.
      const identifierCount = await prisma.shopperIdentifier.count({ where: { shopperId: customer.id } });

      if (dryRun) {
        details.Transaction_unlinked = txnIds.length;
        details.ShopperConsent = consentCount;
        details.LoyaltyCard = loyaltyCardCount;
        details.ScannedReceipt = scannedReceiptCount;
        details.ShopperIdentifier = identifierCount;
        details.Customer = 1;
      } else {
        // ScannedReceipt.customerId and ShopperIdentifier.shopperId are both
        // ON DELETE RESTRICT (see prisma/schema.prisma) -- those rows have to
        // go before the Customer delete below or Postgres rejects the whole
        // transaction. Order matters here, not just membership.
        const results = await prisma.$transaction([
          prisma.shopperConsent.deleteMany({ where: { receiptId: { in: txnIds } } }),
          prisma.transaction.updateMany({ where: { id: { in: txnIds } }, data: { customerId: null } }),
          prisma.loyaltyCard.deleteMany({ where: { customerId: customer.id } }),
          prisma.scannedReceipt.deleteMany({ where: { customerId: customer.id } }),
          prisma.shopperIdentifier.deleteMany({ where: { shopperId: customer.id } }),
          prisma.customer.delete({ where: { id: customer.id } }),
        ]);
        details.ShopperConsent = results[0].count;
        details.Transaction_unlinked = results[1].count;
        details.LoyaltyCard = results[2].count;
        details.ScannedReceipt = results[3].count;
        details.ShopperIdentifier = results[4].count;
        details.Customer = 1;

        for (const mId of merchantIds) {
          await suppressEmail({ email, merchantId: mId, reason: 'deletion_requested' });
        }
      }
    }
  } catch (err) {
    error = err.message;
    console.error('[dataRetentionService] deleteShopperEverywhere failed:', err);
  }

  await writePurgeLog({
    jobName: 'deleteShopperEverywhere',
    dryRun,
    details,
    error,
    initiatedByMerchantId,
    startedAt,
  });
  return { found, details, error };
}

/**
 * Shopify's shop/redact compliance webhook: fired ~48 hours after a
 * merchant uninstalls the app (or on request), meaning ReceipTap no longer
 * has any authorization to hold that shop's data and must erase it -- not
 * just disconnect credentials the way the dashboard's own "Disconnect"
 * button does (routes/account-settings.js's POS_DISCONNECT_FIELDS only
 * clears shopifyShopDomain/shopifyAccessToken, leaving past Transaction
 * rows in place on purpose for the merchant's own records). Here the
 * Transaction rows themselves ARE the shop's data, so they're hard-deleted,
 * scoped strictly to posProvider: 'shopify' and this exact shop domain --
 * a merchant's Square/Clover/Lightspeed history is untouched.
 */
async function purgeShopifyShopData(shopDomain, { dryRun = true } = {}) {
  const startedAt = new Date();
  const details = { Transaction: 0, ShopperConsent: 0, Puck_unassigned: 0 };
  let error = null;
  let found = false;

  try {
    const merchant = await prisma.merchant.findUnique({ where: { shopifyShopDomain: shopDomain } });
    if (merchant) {
      found = true;
      const txnIds = (
        await prisma.transaction.findMany({
          where: { merchantId: merchant.id, posProvider: 'shopify', posLocationId: shopDomain },
          select: { id: true },
        })
      ).map((t) => t.id);

      const consentCount = await prisma.shopperConsent.count({ where: { receiptId: { in: txnIds } } });
      const puckCount = await prisma.puck.count({
        where: { merchantId: merchant.id, posLocationId: shopDomain },
      });

      if (dryRun) {
        details.Transaction = txnIds.length;
        details.ShopperConsent = consentCount;
        details.Puck_unassigned = puckCount;
      } else {
        const results = await prisma.$transaction([
          prisma.shopperConsent.deleteMany({ where: { receiptId: { in: txnIds } } }),
          prisma.transaction.deleteMany({ where: { id: { in: txnIds } } }),
          prisma.puck.updateMany({
            where: { merchantId: merchant.id, posLocationId: shopDomain },
            data: { posLocationId: null, posDeviceId: null, currentTransactionId: null, transactionExpiresAt: null },
          }),
          prisma.merchant.update({
            where: { id: merchant.id },
            data: { shopifyShopDomain: null, shopifyAccessToken: null },
          }),
        ]);
        details.ShopperConsent = results[0].count;
        details.Transaction = results[1].count;
        details.Puck_unassigned = results[2].count;
      }
    }
  } catch (err) {
    error = err.message;
    console.error('[dataRetentionService] purgeShopifyShopData failed:', err);
  }

  await writePurgeLog({
    jobName: 'purgeShopifyShopData',
    dryRun,
    details,
    error,
    initiatedByMerchantId: null,
    startedAt,
  });
  return { found, details, error };
}

module.exports = {
  purgeExpiredReceipts,
  purgeDeactivatedMerchants,
  deleteShopperByEmail,
  deleteShopperEverywhere,
  purgeShopifyShopData,
};
