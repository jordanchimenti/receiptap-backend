-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "paypalMerchantId" TEXT,
ADD COLUMN     "paypalOnboarded" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SplitPayment" ADD COLUMN     "paypalOrderId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Customer_paypalMerchantId_key" ON "Customer"("paypalMerchantId");

-- CreateIndex
CREATE UNIQUE INDEX "SplitPayment_paypalOrderId_key" ON "SplitPayment"("paypalOrderId");

