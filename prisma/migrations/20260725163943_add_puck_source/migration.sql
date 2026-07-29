-- CreateEnum
CREATE TYPE "PuckSource" AS ENUM ('BATCH', 'ADMIN');

-- AlterTable
ALTER TABLE "Puck" ADD COLUMN     "source" "PuckSource" NOT NULL DEFAULT 'BATCH';
