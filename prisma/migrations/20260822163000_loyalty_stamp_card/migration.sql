-- AlterTable
ALTER TABLE "LoyaltyProgram" ADD COLUMN     "cardAccent" TEXT NOT NULL DEFAULT '#FFFFFF',
ADD COLUMN     "cardBackground" TEXT NOT NULL DEFAULT '#0A84FF',
ADD COLUMN     "cardLogoUrl" TEXT,
ADD COLUMN     "earnAmountCents" INTEGER NOT NULL DEFAULT 1000,
ADD COLUMN     "earnItemName" TEXT,
ADD COLUMN     "earnRule" TEXT NOT NULL DEFAULT 'ORDER',
ADD COLUMN     "headStartStamps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rewardLabel" TEXT NOT NULL DEFAULT 'Free reward',
ADD COLUMN     "stampsRequired" INTEGER NOT NULL DEFAULT 10;

-- AlterTable
ALTER TABLE "LoyaltyCard" ADD COLUMN     "lastStampedAt" TIMESTAMP(3);


-- Backfill: programs that already existed were built around a hardcoded
-- 5-punch card and a %/$ offer. Keep both so cards already in a customer's
-- wallet don't move further from a reward, and so nobody's configured offer
-- silently becomes the "Free reward" default. New programs get the defaults
-- above (10 stamps, "Free reward").
UPDATE "LoyaltyProgram"
SET "stampsRequired" = 5,
    "rewardLabel" = CASE
      WHEN "offerType" = 'AMOUNT' THEN '$' || to_char("offerValue" / 100.0, 'FM999999990.00') || ' off'
      ELSE "offerValue"::text || '% off'
    END;
