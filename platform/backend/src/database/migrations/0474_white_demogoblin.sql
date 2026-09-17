-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=All constraints target guardrails_policy_revisions, created empty in this migration. Foreign key validation scans no existing rows. Organization deletion intentionally removes its policies; deleting an author preserves revisions with a null attribution.
CREATE TABLE "guardrails_policy_revisions" (
	"organization_id" text NOT NULL,
	"revision" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guardrails_policy_revisions_organization_id_revision_pk" PRIMARY KEY("organization_id","revision")
);
--> statement-breakpoint
ALTER TABLE "guardrails_policy_revisions" ADD CONSTRAINT "guardrails_policy_revisions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrails_policy_revisions" ADD CONSTRAINT "guardrails_policy_revisions_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;