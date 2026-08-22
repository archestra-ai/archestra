-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Generalizes a new beta-only per-viewer dismissal table. Existing needs-reauth rows are backfilled from their connection and OAuth episode before either new column becomes NOT NULL; the dropped timestamp is preserved as the v1 fingerprint. The replaced unique/check constraints are recreated below with the wider target and kind vocabulary.

ALTER TABLE "mcp_server_alert_mutes" DROP CONSTRAINT "mcp_server_alert_mutes_issue_kind_check";--> statement-breakpoint
DROP INDEX "mcp_server_alert_mutes_viewer_alert_uidx";--> statement-breakpoint
ALTER TABLE "mcp_server_alert_mutes" ALTER COLUMN "mcp_server_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server_alert_mutes" ADD COLUMN "catalog_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_server_alert_mutes" ADD COLUMN "issue_fingerprint" text;--> statement-breakpoint
UPDATE "mcp_server_alert_mutes" AS "dismissal"
SET
	"catalog_id" = "server"."catalog_id",
	"issue_fingerprint" = 'v1:needs-reauth:' || to_char("dismissal"."oauth_refresh_failed_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM "mcp_server" AS "server"
WHERE "server"."id" = "dismissal"."mcp_server_id";--> statement-breakpoint
ALTER TABLE "mcp_server_alert_mutes" ALTER COLUMN "catalog_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server_alert_mutes" ALTER COLUMN "issue_fingerprint" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_server_alert_mutes" ADD CONSTRAINT "mcp_server_alert_mutes_catalog_id_internal_mcp_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."internal_mcp_catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_server_alert_mutes_viewer_server_alert_uidx" ON "mcp_server_alert_mutes" USING btree ("user_id","mcp_server_id","issue_kind") WHERE "mcp_server_alert_mutes"."mcp_server_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_server_alert_mutes_viewer_catalog_alert_uidx" ON "mcp_server_alert_mutes" USING btree ("user_id","catalog_id","issue_kind") WHERE "mcp_server_alert_mutes"."mcp_server_id" is null;--> statement-breakpoint
CREATE INDEX "mcp_server_alert_mutes_catalog_id_idx" ON "mcp_server_alert_mutes" USING btree ("catalog_id");--> statement-breakpoint
ALTER TABLE "mcp_server_alert_mutes" DROP COLUMN "oauth_refresh_failed_at";--> statement-breakpoint
ALTER TABLE "mcp_server_alert_mutes" ADD CONSTRAINT "mcp_server_alert_mutes_issue_kind_check" CHECK ("mcp_server_alert_mutes"."issue_kind" in ('failed-to-start', 'not-running', 'needs-reauth', 'reinstall-required', 'awaiting-approval', 'stuck-starting'));
