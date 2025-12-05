CREATE TABLE "profile_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"name" varchar(256) NOT NULL,
	"secret_id" uuid NOT NULL,
	"token_start" varchar(16) NOT NULL,
	"is_organization_token" boolean DEFAULT false NOT NULL,
	"team_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	CONSTRAINT "profile_token_profile_id_name_unique" UNIQUE("profile_id","name")
);
--> statement-breakpoint
ALTER TABLE "agent_tools" ADD COLUMN "use_dynamic_team_credential" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_token" ADD CONSTRAINT "profile_token_profile_id_agents_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_token" ADD CONSTRAINT "profile_token_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_token" ADD CONSTRAINT "profile_token_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_profile_token_profile_id" ON "profile_token" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "idx_profile_token_secret_id" ON "profile_token" USING btree ("secret_id");--> statement-breakpoint
CREATE INDEX "idx_profile_token_team_id" ON "profile_token" USING btree ("team_id");