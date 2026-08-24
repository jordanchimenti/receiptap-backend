-- AlterTable
ALTER TABLE "ScannedReceipt" ADD COLUMN     "aiReasoning" TEXT,
ADD COLUMN     "aiTaxDeductible" BOOLEAN,
ADD COLUMN     "taxDeductible" BOOLEAN;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "taxDeductible" BOOLEAN;

