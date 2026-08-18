-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=the flagged FOREIGN KEY validates verified_by on batch_analysis_cells, a table that exists only on this unreleased feature branch and holds at most a few thousand development rows, all with NULL verified_by; the referenced user table is only read for the check, so validation is instant and takes no write-blocking lock of consequence.
ALTER TABLE "batch_analysis_cells" ADD COLUMN "flag" text;--> statement-breakpoint
ALTER TABLE "batch_analysis_cells" ADD COLUMN "verified_by" text;--> statement-breakpoint
ALTER TABLE "batch_analysis_cells" ADD COLUMN "verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "batch_analysis_cells" ADD CONSTRAINT "batch_analysis_cells_verified_by_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;