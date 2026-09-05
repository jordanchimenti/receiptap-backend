-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "squareAccessTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "squareRefreshToken" TEXT;
