-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Each new key (organization_id, session_id, operation_id | tool_call_id) widens the old (session_id, operation_id | tool_call_id) key, so every existing row, unique under the old key, is already unique under the new one and the constraints cannot fail. organization_id is already NOT NULL. OpenAPPA writers are stopped for this upgrade, since old and new writers take different advisory lock keys, and lock_timeout bounds the wait for the exclusive locks so a busy table fails the migration instead of stalling receipt writes.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "openappa_operations" DROP CONSTRAINT "openappa_operations_pk";
--> statement-breakpoint
ALTER TABLE "openappa_operations" ADD CONSTRAINT "openappa_operations_pk" PRIMARY KEY("organization_id","session_id","operation_id");--> statement-breakpoint
ALTER TABLE "openappa_processed_results" DROP CONSTRAINT "openappa_results_pk";
--> statement-breakpoint
ALTER TABLE "openappa_processed_results" ADD CONSTRAINT "openappa_results_pk" PRIMARY KEY("organization_id","session_id","tool_call_id");
