CREATE TYPE "public"."agent_scope" AS ENUM('personal', 'team', 'org');--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "author_id" text REFERENCES "user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "scope" "agent_scope" DEFAULT 'personal' NOT NULL;--> statement-breakpoint
CREATE INDEX "agents_author_id_idx" ON "agents" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "agents_scope_idx" ON "agents" USING btree ("scope");--> statement-breakpoint
UPDATE "agents" SET "scope" = 'org'
  WHERE "id" NOT IN (SELECT DISTINCT "agent_id" FROM "agent_team");--> statement-breakpoint
UPDATE "agents" SET "scope" = 'team'
  WHERE "id" IN (SELECT DISTINCT "agent_id" FROM "agent_team");