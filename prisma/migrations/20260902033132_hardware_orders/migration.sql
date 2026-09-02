-- CreateEnum
CREATE TYPE "HardwareOrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'LABEL_PURCHASED', 'IN_TRANSIT', 'DELIVERED', 'CANCELED');

-- CreateTable
CREATE TABLE "HardwareOrder" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "shippingFeeCents" INTEGER NOT NULL,
    "shippingName" TEXT NOT NULL,
    "shippingStreet1" TEXT NOT NULL,
    "shippingStreet2" TEXT,
    "shippingCity" TEXT NOT NULL,
    "shippingRegion" TEXT NOT NULL,
    "shippingPostalCode" TEXT NOT NULL,
    "shippingCountry" TEXT NOT NULL DEFAULT 'CA',
    "shippingPhone" TEXT,
    "status" "HardwareOrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "stripeCheckoutSessionId" TEXT,
    "stripePaymentIntentId" TEXT,
    "labelUrl" TEXT,
    "trackingCode" TEXT,
    "trackingUrl" TEXT,
    "easypostTrackerId" TEXT,
    "paidAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HardwareOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HardwareOrder_orderNumber_key" ON "HardwareOrder"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "HardwareOrder_stripeCheckoutSessionId_key" ON "HardwareOrder"("stripeCheckoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "HardwareOrder_easypostTrackerId_key" ON "HardwareOrder"("easypostTrackerId");

-- CreateIndex
CREATE INDEX "HardwareOrder_merchantId_createdAt_idx" ON "HardwareOrder"("merchantId", "createdAt");

-- AddForeignKey
ALTER TABLE "HardwareOrder" ADD CONSTRAINT "HardwareOrder_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
