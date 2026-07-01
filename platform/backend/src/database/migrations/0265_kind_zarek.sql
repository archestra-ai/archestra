CREATE TABLE "service_account_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_start" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"last_used_at" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_account_tokens" ADD CONSTRAINT "service_account_tokens_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_account_tokens_service_account_id_idx" ON "service_account_tokens" USING btree ("service_account_id");--> statement-breakpoint
CREATE INDEX "service_account_tokens_token_start_idx" ON "service_account_tokens" USING btree ("token_start");--> statement-breakpoint
CREATE UNIQUE INDEX "service_account_tokens_token_hash_unique_idx" ON "service_account_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "service_accounts_organization_id_idx" ON "service_accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_accounts_organization_id_name_unique_idx" ON "service_accounts" USING btree ("organization_id","name");