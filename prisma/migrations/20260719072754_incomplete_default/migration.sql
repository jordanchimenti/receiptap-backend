-- AlterTable
ALTER TABLE "Merchant" ALTER COLUMN "subscriptionStatus" SET DEFAULT 'INCOMPLETE',
ALTER COLUMN "trialEndsAt" DROP DEFAULT;
