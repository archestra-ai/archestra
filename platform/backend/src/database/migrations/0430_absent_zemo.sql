-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Every flagged operation applies to mcp_server_alert_mutes, a table created by this migration, so there is no existing data or older writer to disrupt. The partial unique indexes enforce one viewer decision per server- or catalog-level alert. Cascades remove dismissals when their viewer, catalog item, or connection no longer exists. Concurrent indexes are unnecessary for a new empty table and cannot run inside the migration transaction.

CREATE TABLE "mcp_server_alert_mutes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"catalog_id" uuid NOT NULL,
	"mcp_server_id" uuid,
	"issue_kind" text NOT NULL,
	"issue_fingerprint" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_server_alert_mutes_issue_kind_check" CHECK ("mcp_server_alert_mutes"."issue_kind" in ('failed-to-start', 'not-running', 'needs-reauth'))
);
--> statement-breakpoint
ALTER TABLE "mcp_server_alert_mutes" ADD CONSTRAINT "mcp_server_alert_mutes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_alert_mutes" ADD CONSTRAINT "mcp_server_alert_mutes_catalog_id_internal_mcp_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."internal_mcp_catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_alert_mutes" ADD CONSTRAINT "mcp_server_alert_mutes_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_server_alert_mutes_viewer_server_alert_uidx" ON "mcp_server_alert_mutes" USING btree ("user_id","mcp_server_id","issue_kind") WHERE "mcp_server_alert_mutes"."mcp_server_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_server_alert_mutes_viewer_catalog_alert_uidx" ON "mcp_server_alert_mutes" USING btree ("user_id","catalog_id","issue_kind") WHERE "mcp_server_alert_mutes"."mcp_server_id" is null;--> statement-breakpoint
CREATE INDEX "mcp_server_alert_mutes_catalog_id_idx" ON "mcp_server_alert_mutes" USING btree ("catalog_id");--> statement-breakpoint
CREATE INDEX "mcp_server_alert_mutes_mcp_server_id_idx" ON "mcp_server_alert_mutes" USING btree ("mcp_server_id");
