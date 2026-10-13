ALTER TABLE "plugins" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "source_provider" text;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "source_origin" text;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "gitlab_token_id" uuid;--> statement-breakpoint
ALTER TABLE "credential_definitions" ADD COLUMN "gitlab_url" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "source_provider" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "gitlab_token_id" uuid;--> statement-breakpoint
ALTER TABLE "openappa_github_sync" ADD COLUMN "gitlab_token_id" uuid;--> statement-breakpoint
ALTER TABLE "plugins" ADD CONSTRAINT "plugins_gitlab_token_id_credential_definitions_id_fk" FOREIGN KEY ("gitlab_token_id") REFERENCES "public"."credential_definitions"("id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "plugins" VALIDATE CONSTRAINT "plugins_gitlab_token_id_credential_definitions_id_fk";--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_gitlab_token_id_credential_definitions_id_fk" FOREIGN KEY ("gitlab_token_id") REFERENCES "public"."credential_definitions"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "skills" VALIDATE CONSTRAINT "skills_gitlab_token_id_credential_definitions_id_fk";