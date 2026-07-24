-- CreateEnum
CREATE TYPE "PuckStatus" AS ENUM ('UNCLAIMED', 'CLAIMED');

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "squareMerchantId" TEXT,
    "squareAccessToken" TEXT,
    "shopifyShopDomain" TEXT,
    "shopifyAccessToken" TEXT,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Puck" (
    "id" TEXT NOT NULL,
    "claimCode" TEXT NOT NULL,
    "status" "PuckStatus" NOT NULL DEFAULT 'UNCLAIMED',
    "merchantId" TEXT,
    "posLocationId" TEXT,
    "posDeviceId" TEXT,
    "currentTransactionId" TEXT,
    "transactionExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),

    CONSTRAINT "Puck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "posProvider" TEXT NOT NULL,
    "posLocationId" TEXT,
    "posDeviceId" TEXT,
    "lineItems" JSONB NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "tax" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "paymentMethod" TEXT,
    "customerId" TEXT,
    "aiCategory" TEXT,
    "aiTaxDeductible" BOOLEAN,
    "aiReasoning" TEXT,
    "aiCategorizedAt" TIMESTAMP(3),
    "collectedByMerchantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptTheme" (
    "merchantId" TEXT NOT NULL,
    "layoutId" TEXT NOT NULL DEFAULT 'classic',
    "logoUrl" TEXT,
    "primaryColor" TEXT NOT NULL DEFAULT '#111111',
    "accentColor" TEXT NOT NULL DEFAULT '#2563eb',
    "headerText" TEXT,
    "footerText" TEXT,
    "showGoogleReview" BOOLEAN NOT NULL DEFAULT false,
    "googleReviewUrl" TEXT,
    "showWarranty" BOOLEAN NOT NULL DEFAULT false,
    "showLoyalty" BOOLEAN NOT NULL DEFAULT false,
    "showWalletSave" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptTheme_pkey" PRIMARY KEY ("merchantId")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "googleId" TEXT,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_email_key" ON "Merchant"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_squareMerchantId_key" ON "Merchant"("squareMerchantId");

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_shopifyShopDomain_key" ON "Merchant"("shopifyShopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "Puck_claimCode_key" ON "Puck"("claimCode");

-- CreateIndex
CREATE INDEX "Puck_merchantId_idx" ON "Puck"("merchantId");

-- CreateIndex
CREATE INDEX "Puck_claimCode_idx" ON "Puck"("claimCode");

-- CreateIndex
CREATE INDEX "Transaction_merchantId_idx" ON "Transaction"("merchantId");

-- CreateIndex
CREATE INDEX "Transaction_customerId_idx" ON "Transaction"("customerId");

-- CreateIndex
CREATE INDEX "Transaction_collectedByMerchantId_idx" ON "Transaction"("collectedByMerchantId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_email_key" ON "Customer"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_googleId_key" ON "Customer"("googleId");

-- AddForeignKey
ALTER TABLE "Puck" ADD CONSTRAINT "Puck_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_collectedByMerchantId_fkey" FOREIGN KEY ("collectedByMerchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptTheme" ADD CONSTRAINT "ReceiptTheme_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
