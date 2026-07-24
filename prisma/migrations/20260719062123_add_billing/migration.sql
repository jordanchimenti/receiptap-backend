/*
  Warnings:

  - A unique constraint covering the columns `[stripeCustomerId]` on the table `Merchant` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[stripeSubscriptionId]` on the table `Merchant` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED');

-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "stripeCustomerId" TEXT,
ADD COLUMN     "stripeSubscriptionId" TEXT,
ADD COLUMN     "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
ADD COLUMN     "trialEndsAt" TIMESTAMP(3) DEFAULT (now() + interval '14 days');

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_stripeCustomerId_key" ON "Merchant"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_stripeSubscriptionId_key" ON "Merchant"("stripeSubscriptionId");
