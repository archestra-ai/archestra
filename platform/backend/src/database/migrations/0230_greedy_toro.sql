ALTER TABLE "interactions" ADD COLUMN "auth_method" varchar;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "authenticated_app_id" text;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "authenticated_app_name" varchar;