-- Warranty terms for the "Register warranty" block on Receipt design.
-- The block shipped as a toggle with no fields behind it, so merchants could
-- turn a "Register Warranty" button on but never say what the warranty was.
ALTER TABLE "ReceiptTheme" ADD COLUMN "warrantyPeriod" TEXT;
ALTER TABLE "ReceiptTheme" ADD COLUMN "warrantyDetails" TEXT;
ALTER TABLE "ReceiptTheme" ADD COLUMN "warrantyContact" TEXT;
