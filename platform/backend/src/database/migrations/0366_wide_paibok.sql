-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=model_team is created empty in this same migration, so the validating FKs cannot fail existing rows and take no meaningful lock; cascade deletes only remove restriction rows when a model or team is deleted, which is the intended cleanup.
CREATE TABLE "model_team" (
	"model_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "model_team_model_id_team_id_pk" PRIMARY KEY("model_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "model_team" ADD CONSTRAINT "model_team_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_team" ADD CONSTRAINT "model_team_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;