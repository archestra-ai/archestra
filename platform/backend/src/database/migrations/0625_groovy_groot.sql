-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Creates one new, empty table, so its constraints and indexes validate nothing. service_account_tokens gains a nullable column, a foreign key and an index: every existing row has NULL in the new column, and the table holds only API keys and run tokens (a few rows per service account), so validating the key and building the index are brief. The cascades are intended: deleting a service account removes its trust policies, and deleting a trust policy revokes the tokens it issued.
CREATE TABLE "service_account_federated_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"service_account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"issuer" text NOT NULL,
	"audience" text NOT NULL,
	"subject" text NOT NULL,
	"claim_conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_used_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_account_tokens" ADD COLUMN "federated_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "service_account_federated_credentials" ADD CONSTRAINT "service_account_federated_credentials_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_account_federated_credentials" ADD CONSTRAINT "service_account_federated_credentials_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_account_federated_credentials" ADD CONSTRAINT "service_account_federated_credentials_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_account_federated_credentials_sa_issuer_idx" ON "service_account_federated_credentials" USING btree ("service_account_id","issuer");--> statement-breakpoint
CREATE UNIQUE INDEX "service_account_federated_credentials_sa_name_unique_idx" ON "service_account_federated_credentials" USING btree ("service_account_id","name");--> statement-breakpoint
ALTER TABLE "service_account_tokens" ADD CONSTRAINT "service_account_tokens_federated_credential_id_service_account_federated_credentials_id_fk" FOREIGN KEY ("federated_credential_id") REFERENCES "public"."service_account_federated_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_account_tokens_federated_credential_id_idx" ON "service_account_tokens" USING btree ("federated_credential_id");