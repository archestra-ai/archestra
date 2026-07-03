CREATE TABLE "oauth_client_team" (
	"oauth_client_id" text NOT NULL,
	"team_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_client_team_oauth_client_id_team_id_pk" PRIMARY KEY("oauth_client_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "oauth_client_team" ADD CONSTRAINT "oauth_client_team_oauth_client_id_oauth_client_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_client"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "oauth_client_team" ADD CONSTRAINT "oauth_client_team_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE INDEX "idx_oauth_client_team_team_id" ON "oauth_client_team" USING btree ("team_id");