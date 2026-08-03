-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "resetToken" TEXT,
ADD COLUMN     "resetTokenExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_resetToken_key" ON "Merchant"("resetToken");
