-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "phoneCountry" TEXT DEFAULT 'CA';

-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "ownerPhoneCountry" TEXT DEFAULT 'CA';

-- AlterTable
ALTER TABLE "ReceiptTheme" ADD COLUMN     "phoneCountry" TEXT DEFAULT 'CA';
