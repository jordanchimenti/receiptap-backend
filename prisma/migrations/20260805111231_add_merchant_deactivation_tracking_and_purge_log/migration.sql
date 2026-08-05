-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "dataPurgedAt" TIMESTAMP(3),
ADD COLUMN     "deactivatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PurgeLog" (
    "id" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "rowsDeleted" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB,
    "error" TEXT,
    "initiatedByMerchantId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "PurgeLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PurgeLog_jobName_idx" ON "PurgeLog"("jobName");

-- AddForeignKey
ALTER TABLE "PurgeLog" ADD CONSTRAINT "PurgeLog_initiatedByMerchantId_fkey" FOREIGN KEY ("initiatedByMerchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
