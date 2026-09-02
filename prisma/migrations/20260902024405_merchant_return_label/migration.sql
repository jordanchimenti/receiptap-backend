-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "returnLabelGeneratedAt" TIMESTAMP(3),
ADD COLUMN     "returnLabelUrl" TEXT,
ADD COLUMN     "returnTrackingCode" TEXT,
ADD COLUMN     "returnTrackingUrl" TEXT;
