-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The constraints and index target tables created empty in this same migration: the add-validating-constraint rule scans no existing rows, and CONCURRENTLY is unnecessary on a brand-new empty table. The foreign key to openappa_policy_files only takes a brief lock on that table to attach the trigger; it reads none of its rows. Both tables are additive: the previous release ignores them, so the migration runs safely before its pods are replaced. The new guardrails_deployment column has a constant default, so adding it rewrites no rows, the table holds one row in any case, and the previous release ignores the column.
CREATE TABLE "openappa_deployments" (
	"name" text PRIMARY KEY NOT NULL,
	"head" bigint NOT NULL,
	CONSTRAINT "openappa_deployments_head_positive" CHECK ("openappa_deployments"."head" > 0)
);
--> statement-breakpoint
CREATE TABLE "openappa_policy_revisions" (
	"deployment" text NOT NULL,
	"revision" bigint NOT NULL,
	"hash" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openappa_policy_revisions_pk" PRIMARY KEY("deployment","revision"),
	CONSTRAINT "openappa_policy_revisions_revision_positive" CHECK ("openappa_policy_revisions"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "guardrails_deployment" ADD COLUMN "new_session_policy" varchar(16) DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "openappa_policy_revisions" ADD CONSTRAINT "openappa_policy_revisions_deployment_fk" FOREIGN KEY ("deployment") REFERENCES "public"."openappa_deployments"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openappa_policy_revisions" ADD CONSTRAINT "openappa_policy_revisions_hash_fk" FOREIGN KEY ("hash") REFERENCES "public"."openappa_policy_files"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "openappa_policy_revisions_key_idx" ON "openappa_policy_revisions" USING btree ("deployment","hash","revision");