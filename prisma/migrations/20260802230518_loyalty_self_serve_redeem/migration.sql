/*
  Warnings:

  - You are about to drop the column `lastSignatureUrl` on the `LoyaltyCard` table. All the data in the column will be lost.
  - You are about to drop the column `redemptionCode` on the `LoyaltyCard` table. All the data in the column will be lost.
  - You are about to drop the column `redemptionStatus` on the `LoyaltyCard` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "LoyaltyCard_redemptionCode_idx";

-- AlterTable
ALTER TABLE "LoyaltyCard" DROP COLUMN "lastSignatureUrl",
DROP COLUMN "redemptionCode",
DROP COLUMN "redemptionStatus";

-- AlterTable
ALTER TABLE "LoyaltyProgram" ADD COLUMN     "redemptionCode" TEXT NOT NULL DEFAULT 'REWARD';
