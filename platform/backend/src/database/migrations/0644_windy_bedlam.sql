-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The foreign keys and unique index on tuner_suggestions target a table this migration creates empty, so no existing rows are scanned and no older writer uses it. schedule_triggers_org_tuner_kind_uidx is partial on tuner_kind IS NOT NULL, a column this migration adds as nullable with no default: it covers no existing rows, and older writers never set it. Both new columns are nullable without defaults, so no rows are rewritten.
CREATE TABLE "tuner_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"tuner_kind" text NOT NULL,
	"fingerprint" text NOT NULL,
	"source" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"rationale" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"status" text NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_changed_by" text,
	"comment" text,
	"schedule_trigger_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "schedule_trigger_runs" ADD COLUMN "tuner" jsonb;--> statement-breakpoint
ALTER TABLE "schedule_triggers" ADD COLUMN "tuner_kind" text;--> statement-breakpoint
ALTER TABLE "tuner_suggestions" ADD CONSTRAINT "tuner_suggestions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tuner_suggestions" ADD CONSTRAINT "tuner_suggestions_status_changed_by_user_id_fk" FOREIGN KEY ("status_changed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tuner_suggestions" ADD CONSTRAINT "tuner_suggestions_schedule_trigger_run_id_schedule_trigger_runs_id_fk" FOREIGN KEY ("schedule_trigger_run_id") REFERENCES "public"."schedule_trigger_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tuner_suggestions_open_fingerprint_uidx" ON "tuner_suggestions" USING btree ("organization_id","fingerprint") WHERE "tuner_suggestions"."status" = 'open';--> statement-breakpoint
CREATE INDEX "tuner_suggestions_org_fingerprint_idx" ON "tuner_suggestions" USING btree ("organization_id","fingerprint","status_changed_at");--> statement-breakpoint
CREATE INDEX "tuner_suggestions_org_status_idx" ON "tuner_suggestions" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "tuner_suggestions_run_idx" ON "tuner_suggestions" USING btree ("schedule_trigger_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_triggers_org_tuner_kind_uidx" ON "schedule_triggers" USING btree ("organization_id","tuner_kind") WHERE "schedule_triggers"."tuner_kind" IS NOT NULL;