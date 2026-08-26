-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Both skill_marketplace_repo and skill_marketplace_credential are created empty in this same file, so their foreign keys, unique constraints and indexes all validate against zero rows. On skill_share_link_revision the new repo_id column is NULL for every existing row: the (repo_id, sequence) unique index therefore covers no rows (NULLs never conflict), the new foreign key validates nothing, and the owner CHECK holds for every existing row (link_id NOT NULL, repo_id NULL) and for anything an older app version writes, since older code only ever sets link_id. Dropping NOT NULL on link_id only widens what is accepted. The revision table holds one row per materialized marketplace commit, so the index builds take no meaningful lock. ON DELETE cascade is intentional throughout: a viewer's materialized marketplace and their marketplace credential are both scoped to one user in one organization and must not outlive either.
CREATE TABLE "skill_marketplace_credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_start" text NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skill_marketplace_credential_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "skill_marketplace_repo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text,
	"marketplace_name" text NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_share_link_revision" ALTER COLUMN "link_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "skill_marketplace_anonymous_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_share_link_revision" ADD COLUMN "repo_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_marketplace_credential" ADD CONSTRAINT "skill_marketplace_credential_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_marketplace_credential" ADD CONSTRAINT "skill_marketplace_credential_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_marketplace_repo" ADD CONSTRAINT "skill_marketplace_repo_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_marketplace_repo" ADD CONSTRAINT "skill_marketplace_repo_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_marketplace_credential_org_user_idx" ON "skill_marketplace_credential" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_marketplace_repo_org_user_uidx" ON "skill_marketplace_repo" USING btree ("organization_id","user_id") WHERE "skill_marketplace_repo"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_marketplace_repo_org_anon_uidx" ON "skill_marketplace_repo" USING btree ("organization_id") WHERE "skill_marketplace_repo"."user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "skill_share_link_revision" ADD CONSTRAINT "skill_share_link_revision_repo_id_skill_marketplace_repo_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."skill_marketplace_repo"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_share_link_revision_repo_seq_idx" ON "skill_share_link_revision" USING btree ("repo_id","sequence");--> statement-breakpoint
CREATE INDEX "skill_share_link_revision_repo_id_idx" ON "skill_share_link_revision" USING btree ("repo_id");--> statement-breakpoint
ALTER TABLE "skill_share_link_revision" ADD CONSTRAINT "skill_share_link_revision_owner_check" CHECK (("skill_share_link_revision"."link_id" IS NULL) != ("skill_share_link_revision"."repo_id" IS NULL));