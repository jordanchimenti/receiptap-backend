-- DropForeignKey
ALTER TABLE "HardwareOrder" DROP CONSTRAINT "HardwareOrder_merchantId_fkey";

-- AlterTable
ALTER TABLE "Affiliate" ADD COLUMN     "addressCity" TEXT,
ADD COLUMN     "addressCountry" TEXT,
ADD COLUMN     "addressLine1" TEXT,
ADD COLUMN     "addressLine2" TEXT,
ADD COLUMN     "addressPostalCode" TEXT,
ADD COLUMN     "addressRegion" TEXT,
ADD COLUMN     "phone" TEXT;

-- AlterTable
ALTER TABLE "HardwareOrder" ADD COLUMN     "affiliateId" TEXT,
ALTER COLUMN "merchantId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "HardwareOrder_affiliateId_createdAt_idx" ON "HardwareOrder"("affiliateId", "createdAt");

-- AddForeignKey
ALTER TABLE "HardwareOrder" ADD CONSTRAINT "HardwareOrder_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HardwareOrder" ADD CONSTRAINT "HardwareOrder_affiliateId_fkey" FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
