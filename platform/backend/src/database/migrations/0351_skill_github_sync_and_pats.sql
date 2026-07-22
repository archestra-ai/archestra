CREATE TABLE "github_pats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"secret_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "github_sync_interval" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "github_sync_ref" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "github_app_config_id" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "github_pat_id" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "last_synced_at" timestamp;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "last_sync_error" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "usage_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "last_used_at" timestamp;--> statement-breakpoint
ALTER TABLE "github_pats" ADD CONSTRAINT "github_pats_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "github_pats" VALIDATE CONSTRAINT "github_pats_secret_id_secret_id_fk";--> statement-breakpoint
CREATE INDEX "github_pats_organization_id_idx" ON "github_pats" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_github_app_config_id_github_app_configs_id_fk" FOREIGN KEY ("github_app_config_id") REFERENCES "public"."github_app_configs"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "skills" VALIDATE CONSTRAINT "skills_github_app_config_id_github_app_configs_id_fk";--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_github_pat_id_github_pats_id_fk" FOREIGN KEY ("github_pat_id") REFERENCES "public"."github_pats"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "skills" VALIDATE CONSTRAINT "skills_github_pat_id_github_pats_id_fk";--> statement-breakpoint
CREATE INDEX "skills_github_sync_due_idx" ON "skills" USING btree ("last_synced_at") WHERE "skills"."github_sync_interval" is not null;