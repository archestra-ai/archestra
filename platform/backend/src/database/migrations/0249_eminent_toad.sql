CREATE TABLE "skill_team" (
	"skill_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skill_team_skill_id_team_id_pk" PRIMARY KEY("skill_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "scope" text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
-- backfill: skills created before scoping were visible org-wide
UPDATE "skills" SET "scope" = 'org';--> statement-breakpoint
ALTER TABLE "skill_team" ADD CONSTRAINT "skill_team_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_team" ADD CONSTRAINT "skill_team_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skills_scope_idx" ON "skills" USING btree ("scope");