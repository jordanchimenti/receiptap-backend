-- CreateTable
CREATE TABLE "ScannedReceipt" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "merchantName" TEXT NOT NULL,
    "purchaseDate" TIMESTAMP(3),
    "total" INTEGER NOT NULL,
    "aiCategory" TEXT,
    "lineItems" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScannedReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScannedReceipt_customerId_idx" ON "ScannedReceipt"("customerId");

-- AddForeignKey
ALTER TABLE "ScannedReceipt" ADD CONSTRAINT "ScannedReceipt_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

