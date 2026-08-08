-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "lightspeedAccessToken" TEXT,
ADD COLUMN     "lightspeedAccessTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "lightspeedDomainPrefix" TEXT,
ADD COLUMN     "lightspeedRefreshToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_lightspeedDomainPrefix_key" ON "Merchant"("lightspeedDomainPrefix");
