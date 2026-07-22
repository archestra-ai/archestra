-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=skills.environment_id moves to the new skill_environment junction table in the same release; the skills table is small (no lock risk) and no reader of the old column remains after this deploy.
CREATE TABLE "skill_environment" (
	"skill_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skill_environment_skill_id_environment_id_pk" PRIMARY KEY("skill_id","environment_id")
);
--> statement-breakpoint
ALTER TABLE "skills" DROP CONSTRAINT "skills_environment_id_environments_id_fk";
--> statement-breakpoint
DROP INDEX "skills_environment_id_idx";--> statement-breakpoint
ALTER TABLE "skill_environment" ADD CONSTRAINT "skill_environment_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_environment" ADD CONSTRAINT "skill_environment_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_environment_environment_id_idx" ON "skill_environment" USING btree ("environment_id");--> statement-breakpoint
-- Data migration: carry existing single-environment assignments into the
-- junction table. Skills previously on the Default environment (NULL) get no
-- rows, which under the new semantics makes them available in every
-- environment (previously: Default only).
INSERT INTO "skill_environment" ("skill_id", "environment_id")
SELECT "id", "environment_id" FROM "skills" WHERE "environment_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "environment_id";