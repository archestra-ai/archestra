ALTER TABLE "oauth_client" ADD COLUMN "subject_type" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "require_pkce" boolean;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "auth_time" timestamp;