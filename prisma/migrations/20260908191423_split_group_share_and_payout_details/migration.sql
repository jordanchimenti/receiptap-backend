-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "interacContact" TEXT,
ADD COLUMN     "paypalMeHandle" TEXT;

-- CreateTable
CREATE TABLE "SplitGroupShareLink" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SplitGroupShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SplitGroupShareLink_token_key" ON "SplitGroupShareLink"("token");

-- CreateIndex
CREATE INDEX "SplitGroupShareLink_groupId_idx" ON "SplitGroupShareLink"("groupId");

-- AddForeignKey
ALTER TABLE "SplitGroupShareLink" ADD CONSTRAINT "SplitGroupShareLink_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SplitGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
