-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=the FK targets a2a_push_notification_config, created empty in this same migration, so constraint validation scans nothing
CREATE TABLE "a2a_push_notification_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"url" text NOT NULL,
	"token" text,
	"auth_scheme" text,
	"auth_credentials" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "a2a_push_notification_config" ADD CONSTRAINT "a2a_push_notification_config_task_id_a2a_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."a2a_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "a2a_push_notification_config_task_id_idx" ON "a2a_push_notification_config" USING btree ("task_id");