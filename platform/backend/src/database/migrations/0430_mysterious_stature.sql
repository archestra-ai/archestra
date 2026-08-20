-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Every flagged operation applies to mcp_server_alert_mutes, a table this migration creates in the same statement, so there is no existing data to fail the unique index and no older writer to break. The unique index IS the feature: one mute per (viewer, connection, alert kind) is what makes a re-mute replace the caller's own row instead of accumulating duplicates. The two cascades are deliberate: a mute is meaningless once its viewer or its connection is gone, and leaving orphans would let a deleted user's mute keep hiding an alert. CONCURRENTLY is neither needed nor permitted here: the table is empty and cannot be locked against anyone, and CREATE INDEX CONCURRENTLY cannot run inside the transaction the migration runner uses.

CREATE TABLE "mcp_server_alert_mutes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"issue_kind" text NOT NULL,
	"reason" text NOT NULL,
	"oauth_refresh_failed_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_server_alert_mutes_issue_kind_check" CHECK ("mcp_server_alert_mutes"."issue_kind" in ('needs-reauth'))
);
--> statement-breakpoint
ALTER TABLE "mcp_server_alert_mutes" ADD CONSTRAINT "mcp_server_alert_mutes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_alert_mutes" ADD CONSTRAINT "mcp_server_alert_mutes_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_server_alert_mutes_viewer_alert_uidx" ON "mcp_server_alert_mutes" USING btree ("user_id","mcp_server_id","issue_kind");--> statement-breakpoint
CREATE INDEX "mcp_server_alert_mutes_mcp_server_id_idx" ON "mcp_server_alert_mutes" USING btree ("mcp_server_id");
