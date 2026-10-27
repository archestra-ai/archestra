-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The foreign keys and the partial unique index target a table created empty in this migration, so validation scans no rows and no existing writer can conflict. ON DELETE CASCADE intentionally removes a backfill job with its model or organization.
CREATE TABLE "model_cost_backfills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"model_id" uuid NOT NULL,
	"since" timestamp NOT NULL,
	"cutoff" timestamp NOT NULL,
	"pricing" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"phase" text DEFAULT 'main' NOT NULL,
	"cursor_created_at" text,
	"cursor_id" uuid,
	"rows_scanned" integer DEFAULT 0 NOT NULL,
	"rows_updated" integer DEFAULT 0 NOT NULL,
	"rows_estimated" integer NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp,
	"lease_epoch" bigint DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "model_cost_backfills" ADD CONSTRAINT "model_cost_backfills_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_cost_backfills" ADD CONSTRAINT "model_cost_backfills_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_cost_backfills" ADD CONSTRAINT "model_cost_backfills_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_cost_backfills_active_model_idx" ON "model_cost_backfills" USING btree ("model_id") WHERE "model_cost_backfills"."status" in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "model_cost_backfills_model_created_at_idx" ON "model_cost_backfills" USING btree ("model_id","created_at");