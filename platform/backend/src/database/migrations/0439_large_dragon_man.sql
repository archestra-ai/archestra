-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The eval_* tables shipped in the same unreleased beta (0438) and are empty everywhere, so dropping the single-turn input column in favour of the multi-turn messages column loses no data, the NOT NULL adds validate nothing, and the non-concurrent index builds on empty tables block nothing.
ALTER TABLE "eval_cases" ADD COLUMN "messages" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_run_results" ADD COLUMN "messages" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "group_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
CREATE INDEX "eval_runs_group_id_idx" ON "eval_runs" USING btree ("group_id");--> statement-breakpoint
ALTER TABLE "eval_cases" DROP COLUMN "input";--> statement-breakpoint
ALTER TABLE "eval_run_results" DROP COLUMN "input";