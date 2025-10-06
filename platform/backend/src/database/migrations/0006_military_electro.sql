ALTER TABLE "interactions" RENAME COLUMN "tainted" TO "trusted"; --> statement-breakpoint
UPDATE "interactions" SET "trusted" = NOT "trusted";
