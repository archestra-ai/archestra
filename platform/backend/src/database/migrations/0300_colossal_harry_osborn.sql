CREATE TABLE "environment_default_user_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"environment_id" uuid,
	"limit_value" integer NOT NULL,
	"model" jsonb,
	"cleanup_interval" varchar DEFAULT 'calendar_month' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "environment_default_user_limits_environment_unique" UNIQUE("environment_id")
);
--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN "environment_id" uuid;--> statement-breakpoint
ALTER TABLE "environment_default_user_limits" ADD CONSTRAINT "environment_default_user_limits_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_default_user_limits" ADD CONSTRAINT "environment_default_user_limits_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "environment_default_user_limits_org_global_unique" ON "environment_default_user_limits" USING btree ("organization_id") WHERE "environment_default_user_limits"."environment_id" IS NULL;--> statement-breakpoint
CREATE INDEX "environment_default_user_limits_org_idx" ON "environment_default_user_limits" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD CONSTRAINT "knowledge_base_connectors_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interactions_environment_id_idx" ON "interactions" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "knowledge_base_connectors_environment_id_idx" ON "knowledge_base_connectors" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "knowledge_bases_environment_id_idx" ON "knowledge_bases" USING btree ("environment_id");