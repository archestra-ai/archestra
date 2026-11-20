-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Creates one new, empty table, so its constraints and indexes validate nothing. oauth_access_token gains a nullable column whose existing rows are all NULL; its foreign key is added NOT VALID and validated in a separate statement, which does not block writes. No index is added on the new column: it is read only when an admin deletes or narrows a federated credential. The cascades are intended: deleting an OAuth client removes its trust policies, and deleting a trust policy revokes the access tokens it issued.
CREATE TABLE "oauth_client_federated_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"oauth_client_id" text NOT NULL,
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
ALTER TABLE "oauth_access_token" ADD COLUMN "federated_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_client_federated_credentials" ADD CONSTRAINT "oauth_client_federated_credentials_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_federated_credentials" ADD CONSTRAINT "oauth_client_federated_credentials_oauth_client_id_oauth_client_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_federated_credentials" ADD CONSTRAINT "oauth_client_federated_credentials_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_client_federated_credentials_client_issuer_idx" ON "oauth_client_federated_credentials" USING btree ("oauth_client_id","issuer");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_client_federated_credentials_client_name_unique_idx" ON "oauth_client_federated_credentials" USING btree ("oauth_client_id","name");--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD CONSTRAINT "oauth_access_token_federated_credential_id_oauth_client_federated_credentials_id_fk" FOREIGN KEY ("federated_credential_id") REFERENCES "public"."oauth_client_federated_credentials"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "oauth_access_token" VALIDATE CONSTRAINT "oauth_access_token_federated_credential_id_oauth_client_federated_credentials_id_fk";