-- AlterTable
ALTER TABLE "ScannedReceipt" ADD COLUMN     "splitDetails" JSONB,
ADD COLUMN     "splitMethod" TEXT;
