-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=github_app_accounts is created empty in this migration, so its foreign key and unique constraints scan no existing rows, and older releases ignore the table. ON DELETE CASCADE is intended: deleting a provider key frees its GitHub account for a new plan.
CREATE TABLE "github_app_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"provider_api_key_id" uuid NOT NULL,
	"github_url" text NOT NULL,
	"login" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "github_app_accounts_account_unique" UNIQUE("organization_id","github_url","login"),
	CONSTRAINT "github_app_accounts_provider_api_key_unique" UNIQUE("provider_api_key_id")
);
--> statement-breakpoint
ALTER TABLE "github_app_accounts" ADD CONSTRAINT "github_app_accounts_provider_api_key_id_chat_api_keys_id_fk" FOREIGN KEY ("provider_api_key_id") REFERENCES "public"."chat_api_keys"("id") ON DELETE cascade ON UPDATE no action;