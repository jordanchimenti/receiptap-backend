-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "emailVerificationToken" TEXT,
ADD COLUMN     "emailVerificationTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_emailVerificationToken_key" ON "Merchant"("emailVerificationToken");
