-- AlterTable
ALTER TABLE "ReceiptTheme" ADD COLUMN     "phone" TEXT,
ADD COLUMN     "gstHstNumber" TEXT,
ADD COLUMN     "taxLabel" TEXT NOT NULL DEFAULT 'Tax',
ADD COLUMN     "returnPolicy" TEXT;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "orderNumber" TEXT,
ADD COLUMN     "discountTotal" INTEGER NOT NULL DEFAULT 0;
