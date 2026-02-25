-- Create scope enum
CREATE TYPE "agent_scope" AS ENUM ('personal', 'team', 'org');

ALTER TABLE "agents" ADD COLUMN "author_id" text;
ALTER TABLE "agents" ADD COLUMN "scope" "agent_scope" NOT NULL DEFAULT 'personal';

CREATE INDEX "agents_author_id_idx" ON "agents" ("author_id");
CREATE INDEX "agents_scope_idx" ON "agents" ("scope");

-- Backfill: existing teamless agents were org-wide, team-scoped agents stay team
UPDATE "agents" SET "scope" = 'org'
  WHERE "id" NOT IN (SELECT DISTINCT "agent_id" FROM "agent_team");
UPDATE "agents" SET "scope" = 'team'
  WHERE "id" IN (SELECT DISTINCT "agent_id" FROM "agent_team");
