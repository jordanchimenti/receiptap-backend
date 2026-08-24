-- AlterTable
ALTER TABLE "ScannedReceipt" ADD COLUMN     "aiWarrantyMonths" INTEGER,
ADD COLUMN     "warranty14dReminderSentAt" TIMESTAMP(3),
ADD COLUMN     "warranty3dReminderSentAt" TIMESTAMP(3),
ADD COLUMN     "warrantyExpiresAt" TIMESTAMP(3),
ADD COLUMN     "warrantyMonths" INTEGER;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "aiWarrantyMonths" INTEGER,
ADD COLUMN     "warranty14dReminderSentAt" TIMESTAMP(3),
ADD COLUMN     "warranty3dReminderSentAt" TIMESTAMP(3),
ADD COLUMN     "warrantyExpiresAt" TIMESTAMP(3),
ADD COLUMN     "warrantyMonths" INTEGER;

-- CreateIndex
CREATE INDEX "ScannedReceipt_warrantyExpiresAt_idx" ON "ScannedReceipt"("warrantyExpiresAt");

-- CreateIndex
CREATE INDEX "Transaction_warrantyExpiresAt_idx" ON "Transaction"("warrantyExpiresAt");
