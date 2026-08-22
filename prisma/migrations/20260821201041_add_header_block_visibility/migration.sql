-- AlterTable
ALTER TABLE "ReceiptTheme" ADD COLUMN     "showAddress" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showBusinessEmail" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showBusinessName" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showLogo" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showPhone" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showTaxNumber" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showWebsite" BOOLEAN NOT NULL DEFAULT true;
