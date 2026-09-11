-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "stripePayoutId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "method" TEXT NOT NULL,
    "applicationFeeCents" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "failureCode" TEXT,
    "failureReason" TEXT,
    "arrivalDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payout_stripePayoutId_key" ON "Payout"("stripePayoutId");

-- CreateIndex
CREATE INDEX "Payout_customerId_createdAt_idx" ON "Payout"("customerId", "createdAt");

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
