-- CreateEnum
CREATE TYPE "IdentifierType" AS ENUM ('CARD_FINGERPRINT', 'EMAIL', 'PHONE');

-- CreateEnum
CREATE TYPE "SourcePlatform" AS ENUM ('SQUARE', 'CLOVER', 'SHOPIFY', 'LIGHTSPEED', 'TOAST', 'MANUAL');

-- AlterTable
ALTER TABLE "ShopperConsent" ADD COLUMN     "crossMerchantRecognition" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "crossMerchantRecognitionAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ShopperIdentifier" (
    "id" TEXT NOT NULL,
    "shopperId" TEXT NOT NULL,
    "identifierType" "IdentifierType" NOT NULL,
    "identifierValueHash" TEXT NOT NULL,
    "sourcePlatform" "SourcePlatform" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ShopperIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopperIdentifier_shopperId_idx" ON "ShopperIdentifier"("shopperId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopperIdentifier_identifierType_identifierValueHash_source_key" ON "ShopperIdentifier"("identifierType", "identifierValueHash", "sourcePlatform");

-- AddForeignKey
ALTER TABLE "ShopperIdentifier" ADD CONSTRAINT "ShopperIdentifier_shopperId_fkey" FOREIGN KEY ("shopperId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

