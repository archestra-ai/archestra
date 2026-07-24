ALTER TABLE "audit_logs" ADD COLUMN "resource_name" text;--> statement-breakpoint
-- Serves the audit-log resourceId filter (the UI's resource picker), which
-- sends no resourceType, so audit_logs_org_resource_idx only helps up to the
-- org prefix. Not CONCURRENTLY: migrations run in a transaction; audit writes
-- are fire-and-forget so a brief block delays log inserts, not user responses.
CREATE INDEX "audit_logs_org_resource_id_created_at_idx" ON "audit_logs" USING btree ("organization_id","resource_id","created_at" DESC NULLS LAST);