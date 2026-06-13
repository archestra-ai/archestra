-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=all flagged constraints and the unique index target the brand-new app_render_screenshots table created in this migration (no existing rows), so the cascade FKs and the uniqueness cannot fail or remove existing data.
CREATE TABLE "app_render_screenshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"version" integer NOT NULL,
	"mime_type" text NOT NULL,
	"data" text NOT NULL,
	"rendered_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_render_screenshots" ADD CONSTRAINT "app_render_screenshots_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_render_screenshots" ADD CONSTRAINT "app_render_screenshots_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_render_screenshots_app_user_idx" ON "app_render_screenshots" USING btree ("app_id","user_id");