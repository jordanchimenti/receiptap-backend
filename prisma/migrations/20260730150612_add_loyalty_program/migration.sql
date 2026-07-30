-- AlterTable
ALTER TABLE "ReceiptTheme" DROP COLUMN "showLoyalty";

-- CreateTable
CREATE TABLE "LoyaltyProgram" (
    "merchantId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "offerType" TEXT NOT NULL DEFAULT 'PERCENT',
    "offerValue" INTEGER NOT NULL DEFAULT 10,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyProgram_pkey" PRIMARY KEY ("merchantId")
);

-- CreateTable
CREATE TABLE "LoyaltyCard" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "punches" INTEGER NOT NULL DEFAULT 1,
    "redemptionStatus" TEXT NOT NULL DEFAULT 'NONE',
    "redemptionCode" TEXT,
    "lastSignatureUrl" TEXT,
    "lastRedeemedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyCard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoyaltyCard_redemptionCode_idx" ON "LoyaltyCard"("redemptionCode");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyCard_merchantId_customerId_key" ON "LoyaltyCard"("merchantId", "customerId");

-- AddForeignKey
ALTER TABLE "LoyaltyProgram" ADD CONSTRAINT "LoyaltyProgram_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyCard" ADD CONSTRAINT "LoyaltyCard_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyCard" ADD CONSTRAINT "LoyaltyCard_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

