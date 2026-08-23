-- AlterTable
ALTER TABLE "ScannedReceipt" ADD COLUMN     "subtotal" INTEGER,
ADD COLUMN     "tax" INTEGER,
ADD COLUMN     "tip" INTEGER,
ADD COLUMN     "taxNumber" TEXT,
ADD COLUMN     "currency" TEXT,
ADD COLUMN     "merchantAddress" TEXT;
