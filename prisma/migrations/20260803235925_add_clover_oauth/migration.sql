-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "cloverMerchantId" TEXT,
ADD COLUMN     "cloverAccessToken" TEXT,
ADD COLUMN     "cloverRefreshToken" TEXT,
ADD COLUMN     "cloverAccessTokenExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_cloverMerchantId_key" ON "Merchant"("cloverMerchantId");
