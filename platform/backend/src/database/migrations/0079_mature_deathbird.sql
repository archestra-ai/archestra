CREATE TABLE "team_external_group" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"group_identifier" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "team_external_group_team_group_unique" UNIQUE("team_id","group_identifier")
);
--> statement-breakpoint
ALTER TABLE "team_member" ADD COLUMN "synced_from_sso" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "team_external_group" ADD CONSTRAINT "team_external_group_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;