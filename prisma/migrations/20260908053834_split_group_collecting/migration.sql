/*
  Warnings:

  - You are about to drop the column `splitDetails` on the `ScannedReceipt` table. All the data in the column will be lost.
  - You are about to drop the column `splitMethod` on the `ScannedReceipt` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "ScannedReceipt" DROP COLUMN "splitDetails",
DROP COLUMN "splitMethod";

-- CreateTable
CREATE TABLE "SplitGroup" (
    "id" TEXT NOT NULL,
    "scannedReceiptId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'collecting',
    "hostShareCents" INTEGER NOT NULL,
    "items" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SplitGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SplitGuest" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isHost" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SplitGuest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SplitPayment" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "guestId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "itemDescriptions" JSONB NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'cash',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SplitPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SplitGroup_scannedReceiptId_key" ON "SplitGroup"("scannedReceiptId");

-- CreateIndex
CREATE INDEX "SplitGuest_groupId_idx" ON "SplitGuest"("groupId");

-- CreateIndex
CREATE INDEX "SplitPayment_groupId_idx" ON "SplitPayment"("groupId");

-- AddForeignKey
ALTER TABLE "SplitGroup" ADD CONSTRAINT "SplitGroup_scannedReceiptId_fkey" FOREIGN KEY ("scannedReceiptId") REFERENCES "ScannedReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SplitGroup" ADD CONSTRAINT "SplitGroup_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SplitGuest" ADD CONSTRAINT "SplitGuest_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SplitGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SplitPayment" ADD CONSTRAINT "SplitPayment_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SplitGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SplitPayment" ADD CONSTRAINT "SplitPayment_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "SplitGuest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
