-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Both foreign keys are on oauth_client_resource, which this migration creates empty, so the add-validating-constraint rule scans no existing rows; attaching them only briefly locks oauth_client and oauth_resource. ON DELETE CASCADE matches Better Auth's OAuth provider schema: a client-to-resource grant goes with its client or resource. The new indexes are on new or small OAuth token tables.
CREATE TABLE "oauth_client_assertion" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_client_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "oauth_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"policy_version" integer DEFAULT 1,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "oauth_resource_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN "authorization_code_id" text;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN "resources" text[];--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN "requested_user_info_claims" text[];--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN "revoked" timestamp;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN "confirmation" jsonb;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "client_discovery_id" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "client_credentials_scopes" text[] DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "backchannel_logout_uri" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "backchannel_logout_session_required" boolean;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "application_type" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "jwks" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "jwks_uri" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "dpop_bound_access_tokens" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD COLUMN "resources" text[];--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD COLUMN "requested_user_info_claims" text[];--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "authorization_code_id" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "resources" text[];--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "requested_user_info_claims" text[];--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "rotated_at" timestamp;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "rotation_replay_response" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "rotation_replay_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "confirmation" jsonb;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_resource_id_oauth_resource_identifier_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."oauth_resource"("identifier") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_client_resource_client_id_idx" ON "oauth_client_resource" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_client_resource_resource_id_idx" ON "oauth_client_resource" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "oauth_access_token_authorization_code_id_idx" ON "oauth_access_token" USING btree ("authorization_code_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_token_authorization_code_id_idx" ON "oauth_refresh_token" USING btree ("authorization_code_id");