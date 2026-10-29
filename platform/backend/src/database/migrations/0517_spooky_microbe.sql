-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Both foreign keys target openappa_credential_bindings, created empty in this migration, so there are no existing rows to validate. Deleting an organization intentionally removes its bindings.
CREATE TABLE "openappa_credential_bindings" (
	"organization_id" text NOT NULL,
	"variable" text NOT NULL,
	"credential_key" text NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openappa_credential_bindings_organization_id_variable_pk" PRIMARY KEY("organization_id","variable")
);
--> statement-breakpoint
ALTER TABLE "openappa_credential_bindings" ADD CONSTRAINT "openappa_credential_bindings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openappa_credential_bindings" ADD CONSTRAINT "openappa_credential_bindings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;