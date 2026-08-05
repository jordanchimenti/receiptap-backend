-- CreateEnum
CREATE TYPE "LegalDocumentType" AS ENUM ('TERMS', 'PRIVACY', 'DPA');

-- CreateEnum
CREATE TYPE "ConsentType" AS ENUM ('TRANSACTIONAL', 'MARKETING');

-- CreateTable
CREATE TABLE "LegalAcceptance" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "documentType" "LegalDocumentType" NOT NULL,
    "version" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "LegalAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopperConsent" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "consentType" "ConsentType" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "consentTextVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,

    CONSTRAINT "ShopperConsent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LegalAcceptance_merchantId_documentType_idx" ON "LegalAcceptance"("merchantId", "documentType");

-- CreateIndex
CREATE INDEX "ShopperConsent_receiptId_idx" ON "ShopperConsent"("receiptId");

-- AddForeignKey
ALTER TABLE "LegalAcceptance" ADD CONSTRAINT "LegalAcceptance_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopperConsent" ADD CONSTRAINT "ShopperConsent_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
