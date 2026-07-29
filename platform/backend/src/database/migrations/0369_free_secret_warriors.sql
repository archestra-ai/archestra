-- Foreign keys are declared inline rather than added by follow-up ALTERs. The
-- table is created empty in this same migration, so there are no rows for a
-- validating constraint to fail on; the inline form yields an identical schema
-- (same constraint names) without the needless NOT VALID / VALIDATE dance the
-- migration linter would otherwise, correctly in general, insist on.
CREATE TABLE "mcp_catalog_user" (
	"catalog_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"level" text DEFAULT 'use' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_catalog_user_catalog_id_user_id_pk" PRIMARY KEY("catalog_id","user_id"),
	CONSTRAINT "mcp_catalog_user_level_check" CHECK (
      "mcp_catalog_user"."level" in ('use', 'write')),
	CONSTRAINT "mcp_catalog_user_catalog_id_internal_mcp_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."internal_mcp_catalog"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "mcp_catalog_user_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action
);
