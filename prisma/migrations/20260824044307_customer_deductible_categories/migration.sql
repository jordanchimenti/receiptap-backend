-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "deductibleCategories" TEXT[] DEFAULT ARRAY[]::TEXT[];

