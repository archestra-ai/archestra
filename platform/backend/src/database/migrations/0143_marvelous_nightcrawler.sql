ALTER TABLE "sso_provider" RENAME TO "identity_provider";--> statement-breakpoint
ALTER TABLE "identity_provider" DROP CONSTRAINT "sso_provider_provider_id_unique";--> statement-breakpoint
ALTER TABLE "identity_provider" DROP CONSTRAINT "sso_provider_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "identity_provider_id" text;--> statement-breakpoint
ALTER TABLE "mcp_tool_calls" ADD COLUMN "external_identity" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_identity_provider_id_identity_provider_id_fk" FOREIGN KEY ("identity_provider_id") REFERENCES "public"."identity_provider"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_provider" ADD CONSTRAINT "identity_provider_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_identity_provider_id_idx" ON "agents" USING btree ("identity_provider_id");--> statement-breakpoint
ALTER TABLE "identity_provider" ADD CONSTRAINT "identity_provider_provider_id_unique" UNIQUE("provider_id");--> statement-breakpoint
UPDATE "organization_role"
SET "permission" = REPLACE("permission"::text, '"ssoProvider"', '"identityProvider"')::jsonb
WHERE "permission"::text LIKE '%"ssoProvider"%';