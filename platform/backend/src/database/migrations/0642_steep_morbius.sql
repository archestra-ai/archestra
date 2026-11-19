-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The foreign key targets spiffe_signing_keys, which this migration creates empty: the add-validating-constraint rule scans no existing rows, and attaching it only takes a brief lock on secret. ON DELETE CASCADE is intended: a key whose private half is gone cannot sign, so its row goes with it.
CREATE TABLE "spiffe_signing_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"private_key_secret_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spiffe_signing_keys" ADD CONSTRAINT "spiffe_signing_keys_private_key_secret_id_secret_id_fk" FOREIGN KEY ("private_key_secret_id") REFERENCES "public"."secret"("id") ON DELETE cascade ON UPDATE no action;