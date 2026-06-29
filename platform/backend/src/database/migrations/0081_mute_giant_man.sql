CREATE TABLE "team_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"team_id" text,
	"is_organization_token" boolean DEFAULT false NOT NULL,
	"name" varchar(256) NOT NULL,
	"secret_id" uuid NOT NULL,
	"token_start" varchar(16) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	CONSTRAINT "team_token_organization_id_team_id_unique" UNIQUE("organization_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "agent_tools" ADD COLUMN "use_dynamic_team_credential" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "team_token" ADD CONSTRAINT "team_token_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_token" ADD CONSTRAINT "team_token_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_token" ADD CONSTRAINT "team_token_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_team_token_org_id" ON "team_token" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_team_token_team_id" ON "team_token" USING btree ("team_id");
