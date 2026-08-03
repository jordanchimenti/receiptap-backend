-- AlterTable
ALTER TABLE "Merchant" ALTER COLUMN "passwordHash" DROP NOT NULL;
ALTER TABLE "Merchant" ADD COLUMN     "googleId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_googleId_key" ON "Merchant"("googleId");
