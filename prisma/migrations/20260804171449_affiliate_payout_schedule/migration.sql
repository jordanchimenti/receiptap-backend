-- AlterTable
ALTER TABLE "Affiliate" ADD COLUMN     "payoutFrequency" TEXT NOT NULL DEFAULT 'WEEKLY',
ADD COLUMN     "lastPayoutAt" TIMESTAMP(3);
