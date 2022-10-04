-- AlterTable
ALTER TABLE "EventType" ALTER COLUMN "disableGuests" SET DEFAULT true;

-- AlterTable
ALTER TABLE "Team" ALTER COLUMN "hideBranding" SET DEFAULT true;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "hideBranding" SET DEFAULT true,
ALTER COLUMN "plan" SET DEFAULT 'PRO';
