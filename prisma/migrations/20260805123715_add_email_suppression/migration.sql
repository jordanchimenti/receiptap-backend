-- CreateTable
CREATE TABLE "EmailSuppression" (
    "id" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "suppressedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailSuppression_emailHash_merchantId_idx" ON "EmailSuppression"("emailHash", "merchantId");

-- AddForeignKey
ALTER TABLE "EmailSuppression" ADD CONSTRAINT "EmailSuppression_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
