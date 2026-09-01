-- AlterTable
ALTER TABLE "ScannedReceipt" ADD COLUMN     "cashierName" TEXT,
ADD COLUMN     "itemCount" INTEGER,
ADD COLUMN     "merchantPhone" TEXT,
ADD COLUMN     "paymentReferenceNumber" TEXT,
ADD COLUMN     "taxLabel" TEXT;
