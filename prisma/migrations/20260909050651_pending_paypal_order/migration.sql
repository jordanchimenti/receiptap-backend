-- CreateTable
CREATE TABLE "PendingPaypalOrder" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "itemDescriptions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingPaypalOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingPaypalOrder_orderId_key" ON "PendingPaypalOrder"("orderId");

