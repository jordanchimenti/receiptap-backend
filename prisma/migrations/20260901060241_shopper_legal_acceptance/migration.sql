-- CreateEnum
CREATE TYPE "ShopperLegalDocumentType" AS ENUM ('SHOPPER_TERMS', 'SHOPPER_PRIVACY');

-- CreateTable
CREATE TABLE "ShopperLegalAcceptance" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "documentType" "ShopperLegalDocumentType" NOT NULL,
    "version" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "ShopperLegalAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopperLegalAcceptance_customerId_documentType_idx" ON "ShopperLegalAcceptance"("customerId", "documentType");

-- AddForeignKey
ALTER TABLE "ShopperLegalAcceptance" ADD CONSTRAINT "ShopperLegalAcceptance_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
