-- AlterTable
ALTER TABLE "ReceiptTheme" ADD COLUMN     "showApprovalCode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "showCardTail" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showTenderChange" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "amountTenderedCents" INTEGER,
ADD COLUMN     "authCode" TEXT,
ADD COLUMN     "cardBrand" TEXT,
ADD COLUMN     "cardLast4" TEXT,
ADD COLUMN     "changeDueCents" INTEGER;
