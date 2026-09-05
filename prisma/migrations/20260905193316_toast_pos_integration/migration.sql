-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "toastRestaurantGuid" TEXT,
ADD COLUMN     "toastClientId" TEXT,
ADD COLUMN     "toastClientSecret" TEXT,
ADD COLUMN     "toastAccessToken" TEXT,
ADD COLUMN     "toastAccessTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "toastLastPollAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_toastRestaurantGuid_key" ON "Merchant"("toastRestaurantGuid");
