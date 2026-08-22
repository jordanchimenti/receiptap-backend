-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "referralAttributedAt" TIMESTAMP(3),
ADD COLUMN     "referredByAffiliateId" TEXT;

-- CreateIndex
CREATE INDEX "Customer_referredByAffiliateId_idx" ON "Customer"("referredByAffiliateId");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_referredByAffiliateId_fkey" FOREIGN KEY ("referredByAffiliateId") REFERENCES "Affiliate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
