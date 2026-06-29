CREATE TYPE "public"."oauth_refresh_error_enum" AS ENUM('refresh_failed', 'no_refresh_token');--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "oauth_refresh_error" "oauth_refresh_error_enum";--> statement-breakpoint
ALTER TABLE "mcp_server" ADD COLUMN "oauth_refresh_failed_at" timestamp;