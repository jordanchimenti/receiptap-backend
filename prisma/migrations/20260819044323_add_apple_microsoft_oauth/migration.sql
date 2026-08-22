-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "appleId" TEXT,
ADD COLUMN     "microsoftId" TEXT;

-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "appleId" TEXT,
ADD COLUMN     "microsoftId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Customer_appleId_key" ON "Customer"("appleId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_microsoftId_key" ON "Customer"("microsoftId");

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_appleId_key" ON "Merchant"("appleId");

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_microsoftId_key" ON "Merchant"("microsoftId");

