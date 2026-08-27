CREATE TABLE "plugin_skill_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL REFERENCES "public"."plugins"("id") ON DELETE cascade,
	"skill_path" text NOT NULL,
	"user_id" text,
	"session_id" text,
	"context_tokens" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "plugin_skill_usage_plugin_path_created_idx" ON "plugin_skill_usage_events" USING btree ("plugin_id","skill_path","created_at");
