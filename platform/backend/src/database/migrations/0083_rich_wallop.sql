CREATE TABLE "team_vault_folder" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"vault_path" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "team_vault_folder_team_id_unique" UNIQUE("team_id")
);
--> statement-breakpoint
ALTER TABLE "secret" ADD COLUMN "vault_path" varchar(512);--> statement-breakpoint
ALTER TABLE "team_vault_folder" ADD CONSTRAINT "team_vault_folder_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;