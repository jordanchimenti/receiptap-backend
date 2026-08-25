-- AlterTable
-- ScannedReceipt gains updatedAt and tax2. Table is empty (row count
-- confirmed immediately before authoring this migration), so both can be
-- added directly with their final constraints -- no backfill needed.
ALTER TABLE "ScannedReceipt" ADD COLUMN     "tax2" INTEGER,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
-- Transaction gains the seller identity/tax snapshot (see
-- lib/receiptSnapshot.js), currency, tax2, and updatedAt.
--
-- sellerName and updatedAt are added nullable here, not NOT NULL, because
-- Transaction has 27 existing rows predating this migration (24 real
-- Square/Clover/Lightspeed webhook test sales plus 3 demo test-sale rows --
-- no real customer data). Both are tightened to NOT NULL below, once the
-- backfill immediately following gives every row a value.
ALTER TABLE "Transaction" ADD COLUMN     "currency" TEXT,
ADD COLUMN     "sellerAddressCity" TEXT,
ADD COLUMN     "sellerAddressCountry" TEXT,
ADD COLUMN     "sellerAddressLine1" TEXT,
ADD COLUMN     "sellerAddressLine2" TEXT,
ADD COLUMN     "sellerAddressPostalCode" TEXT,
ADD COLUMN     "sellerAddressRegion" TEXT,
ADD COLUMN     "sellerGstHstNumber" TEXT,
ADD COLUMN     "sellerLegalName" TEXT,
ADD COLUMN     "sellerName" TEXT,
ADD COLUMN     "sellerTaxLabel" TEXT NOT NULL DEFAULT 'Tax',
ADD COLUMN     "sellerTaxNumber2" TEXT,
ADD COLUMN     "sellerTaxNumber2Label" TEXT,
ADD COLUMN     "sellerTaxNumberLabel" TEXT,
ADD COLUMN     "tax2" INTEGER,
ADD COLUMN     "updatedAt" TIMESTAMP(3);

-- Backfill the 27 pre-migration rows across the only two merchants that
-- exist today. These carry PRESENT-DAY merchant/theme values (read at
-- migration-authoring time), not sale-date values -- there is no historical
-- source to recover the real ones from. They already render this way today
-- (routes/receipt.js live-joins Merchant/ReceiptTheme before this
-- migration), so nothing regresses for these specific rows. They are NOT
-- evidence the snapshot mechanism works, though -- only a receipt created
-- AFTER this migration, through the updated webhook handlers, proves that.
-- updatedAt backfills to each row's own createdAt, since nothing has
-- actually been updated since these rows were written.

-- ReceipTap (cmrrh5pox0000sj68mfiyvwc5): businessName "ReceipTap", no
-- displayName, no address on file, no GST/HST number on file.
UPDATE "Transaction" SET
  "sellerName" = 'ReceipTap',
  "sellerLegalName" = 'ReceipTap',
  "updatedAt" = "createdAt"
WHERE "merchantId" = 'cmrrh5pox0000sj68mfiyvwc5';

-- jordan's Business (cmsi5g4fn0006ncolhwhh7zmn): businessName "jordan's
-- Business", no displayName, address on file, no GST/HST number on file.
UPDATE "Transaction" SET
  "sellerName" = 'jordan''s Business',
  "sellerLegalName" = 'jordan''s Business',
  "sellerAddressLine1" = '5205 fourth ave',
  "sellerAddressCity" = 'niagara falls',
  "sellerAddressRegion" = 'ontario',
  "updatedAt" = "createdAt"
WHERE "merchantId" = 'cmsi5g4fn0006ncolhwhh7zmn';

-- Every row now has a value for both -- enforce NOT NULL going forward, the
-- same constraint an empty table would have gotten from the start.
ALTER TABLE "Transaction" ALTER COLUMN "sellerName" SET NOT NULL;
ALTER TABLE "Transaction" ALTER COLUMN "updatedAt" SET NOT NULL;
