-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=agent_skills and agent_excluded_skills are created empty in this same migration, so their validating FKs cannot fail existing rows; cascade deletes only remove assignment/exclusion rows when an agent or skill is deleted, which is the intended cleanup. Four columns are added: three nullable with no default (catalog-only), and agents.access_all_skills NOT NULL DEFAULT false, which is metadata-only on PG 11+ and rewrites nothing. Locks held: ACCESS EXCLUSIVE on agents and skills (ADD COLUMN), SHARE ROW EXCLUSIVE on skill_files (CREATE TRIGGER) and on the FK-referenced tables — all table-level, but every statement is O(1) catalog work, so they are held for the duration of a short transaction. Rows written before skill_files.digest / skills.frontmatter_blob existed are digested by an app-driven periodic backfill (services/skill-publication-backfill.ts) rather than in this transaction.
CREATE TABLE "agent_excluded_skills" (
	"agent_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_excluded_skills_agent_id_skill_id_pk" PRIMARY KEY("agent_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "agent_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_skills_agent_id_skill_id_unique" UNIQUE("agent_id","skill_id")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "access_all_skills" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_files" ADD COLUMN "digest" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "frontmatter_blob" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "digest" text;--> statement-breakpoint
ALTER TABLE "agent_excluded_skills" ADD CONSTRAINT "agent_excluded_skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_excluded_skills" ADD CONSTRAINT "agent_excluded_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- Publication integrity for skills served over MCP (SEP-2640).
--
-- A published skill advertises a digest over the exact bytes a client will
-- read back. The application is the single producer of every digest
-- (`skill-manifest-serializer.ts`); the database never computes one — Postgres
-- and Node disagree on non-canonical base64, so two producers would advertise
-- two different digests for the same row. What the database can do is PROVE
-- staleness: these triggers reset the stored artifacts whenever a write moves
-- the bytes they cover without supplying fresh ones. A row in that state is
-- withheld from publication until the next model-layer write (which always
-- writes bytes and digest together) or the periodic backfill restores the pair.

-- skills: any write that moves a covered column without refreshing the digest
-- resets both artifact columns.
CREATE FUNCTION skills_invalidate_publication_artifacts() RETURNS trigger AS $$
BEGIN
  IF (NEW.name, NEW.description, NEW.license, NEW.compatibility,
      NEW.allowed_tools, NEW.metadata, NEW.content)
     IS DISTINCT FROM
     (OLD.name, OLD.description, OLD.license, OLD.compatibility,
      OLD.allowed_tools, OLD.metadata, OLD.content)
     AND NEW.digest IS NOT DISTINCT FROM OLD.digest
  THEN
    NEW.frontmatter_blob := NULL;
    NEW.digest := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- Gated on `digest` rather than `frontmatter_blob`: a content-only edit leaves
-- the blob byte-identical, so a blob-based guard would wrongly invalidate a
-- write that was already correct. The digest covers both halves, so any real
-- change to the published bytes moves it.
CREATE TRIGGER skills_invalidate_publication_artifacts
  BEFORE UPDATE ON skills
  FOR EACH ROW EXECUTE FUNCTION skills_invalidate_publication_artifacts();
--> statement-breakpoint
-- skill_files: same shape. UPDATE only — on INSERT the model layer supplies
-- the digest alongside the bytes, and a row inserted without one (outside the
-- model layer) is simply not published until the backfill digests it.
CREATE FUNCTION skill_files_invalidate_digest() RETURNS trigger AS $$
BEGIN
  IF (NEW.content, NEW.encoding) IS DISTINCT FROM (OLD.content, OLD.encoding)
     AND NEW.digest IS NOT DISTINCT FROM OLD.digest
  THEN
    NEW.digest := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER skill_files_invalidate_digest
  BEFORE UPDATE ON skill_files
  FOR EACH ROW EXECUTE FUNCTION skill_files_invalidate_digest();

-- No backfill in this transaction: an eager one would rewrite every row of
-- both tables under ROW EXCLUSIVE, stalling skill writes and roughly doubling
-- the tables until vacuum. Rows that predate these columns are instead
-- digested by a batched, idempotent app-side backfill on a periodic task
-- (services/skill-publication-backfill.ts) — app-side because the application
-- is the digest authority, and idempotent (`IS NULL`-guarded) so concurrent
-- pods or repeated boots cannot clobber a fresher write.
