-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The self-FK targets the all-NULL column added immediately above, so validation has no referenced values to check. The team table is a small administration table rather than a write-hot runtime table, so creating this single-column index transactionally keeps the generated migration atomic without material write risk.
ALTER TABLE "team" ADD COLUMN "parent_team_id" text;--> statement-breakpoint
ALTER TABLE "team" ADD CONSTRAINT "team_parent_team_id_team_id_fk" FOREIGN KEY ("parent_team_id") REFERENCES "public"."team"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_parent_team_id_idx" ON "team" USING btree ("parent_team_id");
