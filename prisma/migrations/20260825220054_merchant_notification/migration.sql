-- CreateTable
CREATE TABLE "MerchantNotification" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "linkUrl" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MerchantNotification_merchantId_createdAt_idx" ON "MerchantNotification"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "MerchantNotification_merchantId_readAt_idx" ON "MerchantNotification"("merchantId", "readAt");

-- AddForeignKey
ALTER TABLE "MerchantNotification" ADD CONSTRAINT "MerchantNotification_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
