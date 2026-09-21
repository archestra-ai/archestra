-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=All four columns are new and NULL on every existing row, and the partial unique index covers only receipt_token IS NOT NULL rows, so it scans no existing data; older writers never write receipt_token (rows stay NULL and outside the index), so no old writer can conflict.
ALTER TABLE "openappa_sessions" ADD COLUMN "forked_from" text;--> statement-breakpoint
ALTER TABLE "openappa_sessions" ADD COLUMN "forked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "openappa_sessions" ADD COLUMN "receipt_token" text;--> statement-breakpoint
ALTER TABLE "openappa_sessions" ADD COLUMN "receipt_issued_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "openappa_sessions_forked_from_idx" ON "openappa_sessions" USING btree ("organization_id","forked_from");--> statement-breakpoint
CREATE INDEX "openappa_sessions_unscoped_session_idx" ON "openappa_sessions" USING btree ("organization_id",substr("session_id", strpos("session_id", '|') + 1));--> statement-breakpoint
CREATE UNIQUE INDEX "openappa_sessions_org_receipt_token_uidx" ON "openappa_sessions" USING btree ("organization_id","receipt_token") WHERE "openappa_sessions"."receipt_token" IS NOT NULL;