-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=new table created in this migration; the unique index and cascade FKs apply to no pre-existing rows
CREATE TABLE "app_render_diagnostics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"version" integer NOT NULL,
	"entries" jsonb NOT NULL,
	"rendered_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_render_diagnostics" ADD CONSTRAINT "app_render_diagnostics_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_render_diagnostics" ADD CONSTRAINT "app_render_diagnostics_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_render_diagnostics_app_user_idx" ON "app_render_diagnostics" USING btree ("app_id","user_id");