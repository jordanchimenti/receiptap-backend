-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "stripeConnectAccountId" TEXT,
ADD COLUMN     "stripeConnectOnboarded" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SplitPayment" ADD COLUMN     "stripePaymentIntentId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Customer_stripeConnectAccountId_key" ON "Customer"("stripeConnectAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "SplitPayment_stripePaymentIntentId_key" ON "SplitPayment"("stripePaymentIntentId");

