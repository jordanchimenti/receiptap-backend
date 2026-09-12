-- AlterTable
ALTER TABLE "ScannedReceipt" ADD COLUMN     "merchantRegistryId" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'photo';

-- CreateTable
CREATE TABLE "MerchantRegistry" (
    "id" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "senderDomain" TEXT,
    "displayName" TEXT NOT NULL,
    "claimedByMerchantId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantRegistry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScannedReceiptSourceDocument" (
    "id" TEXT NOT NULL,
    "scannedReceiptId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScannedReceiptSourceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailConnection" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "EmailConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailInboxConsent" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "consentVersion" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "EmailInboxConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedEmailMessage" (
    "id" TEXT NOT NULL,
    "emailConnectionId" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "scannedReceiptId" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedEmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MerchantRegistry_senderDomain_key" ON "MerchantRegistry"("senderDomain");

-- CreateIndex
CREATE INDEX "MerchantRegistry_normalizedName_idx" ON "MerchantRegistry"("normalizedName");

-- CreateIndex
CREATE INDEX "ScannedReceiptSourceDocument_scannedReceiptId_idx" ON "ScannedReceiptSourceDocument"("scannedReceiptId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailConnection_grantId_key" ON "EmailConnection"("grantId");

-- CreateIndex
CREATE INDEX "EmailConnection_customerId_idx" ON "EmailConnection"("customerId");

-- CreateIndex
CREATE INDEX "EmailInboxConsent_customerId_idx" ON "EmailInboxConsent"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedEmailMessage_providerMessageId_key" ON "ProcessedEmailMessage"("providerMessageId");

-- CreateIndex
CREATE INDEX "ProcessedEmailMessage_emailConnectionId_idx" ON "ProcessedEmailMessage"("emailConnectionId");

-- CreateIndex
CREATE INDEX "ScannedReceipt_merchantRegistryId_idx" ON "ScannedReceipt"("merchantRegistryId");

-- AddForeignKey
ALTER TABLE "ScannedReceipt" ADD CONSTRAINT "ScannedReceipt_merchantRegistryId_fkey" FOREIGN KEY ("merchantRegistryId") REFERENCES "MerchantRegistry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantRegistry" ADD CONSTRAINT "MerchantRegistry_claimedByMerchantId_fkey" FOREIGN KEY ("claimedByMerchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScannedReceiptSourceDocument" ADD CONSTRAINT "ScannedReceiptSourceDocument_scannedReceiptId_fkey" FOREIGN KEY ("scannedReceiptId") REFERENCES "ScannedReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailConnection" ADD CONSTRAINT "EmailConnection_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailInboxConsent" ADD CONSTRAINT "EmailInboxConsent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessedEmailMessage" ADD CONSTRAINT "ProcessedEmailMessage_emailConnectionId_fkey" FOREIGN KEY ("emailConnectionId") REFERENCES "EmailConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
