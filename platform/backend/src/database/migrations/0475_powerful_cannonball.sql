-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=OpenAPPA is unreleased; old session state may be discarded when replacing the session keys.
-- Reset state because session identity no longer includes caller or organization.
TRUNCATE TABLE "openappa_operations", "openappa_processed_results", "openappa_sessions", "openappa_events";
--> statement-breakpoint
ALTER TABLE "openappa_operations" DROP CONSTRAINT "openappa_operations_pk";
--> statement-breakpoint
ALTER TABLE "openappa_processed_results" DROP CONSTRAINT "openappa_results_pk";
--> statement-breakpoint
ALTER TABLE "openappa_operations" ALTER COLUMN "caller_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "openappa_processed_results" ALTER COLUMN "caller_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "openappa_sessions" ALTER COLUMN "caller_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "openappa_operations" ADD CONSTRAINT "openappa_operations_pk" PRIMARY KEY("session_id","operation_id");
--> statement-breakpoint
ALTER TABLE "openappa_processed_results" ADD CONSTRAINT "openappa_results_pk" PRIMARY KEY("session_id","tool_call_id");
