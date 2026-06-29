ALTER TABLE "interactions" RENAME COLUMN "tainted" TO "trusted";
UPDATE "interactions" SET "trusted" = NOT "trusted";