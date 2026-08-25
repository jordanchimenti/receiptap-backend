-- CreateTable
CREATE TABLE "ScannedReceiptShareLink" (
    "id" TEXT NOT NULL,
    "scannedReceiptId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScannedReceiptShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScannedReceiptShareLink_token_key" ON "ScannedReceiptShareLink"("token");

-- CreateIndex
CREATE INDEX "ScannedReceiptShareLink_scannedReceiptId_idx" ON "ScannedReceiptShareLink"("scannedReceiptId");

-- AddForeignKey
ALTER TABLE "ScannedReceiptShareLink" ADD CONSTRAINT "ScannedReceiptShareLink_scannedReceiptId_fkey" FOREIGN KEY ("scannedReceiptId") REFERENCES "ScannedReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
