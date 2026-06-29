CREATE TABLE "agent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"source" text NOT NULL,
	"created_by" text,
	"created_by_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_versions_agent_id_version_number_uniq" UNIQUE("agent_id","version_number")
);
--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_versions_agent_id_created_at_idx" ON "agent_versions" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_versions_org_id_idx" ON "agent_versions" USING btree ("organization_id");