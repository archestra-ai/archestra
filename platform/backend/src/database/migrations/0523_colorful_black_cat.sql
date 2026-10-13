ALTER TABLE "interactions" ADD COLUMN "billing_team_id" text;--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ADD COLUMN "billing_team_id" text;--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ADD CONSTRAINT "virtual_api_keys_billing_team_id_team_id_fk" FOREIGN KEY ("billing_team_id") REFERENCES "public"."team"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "virtual_api_keys" VALIDATE CONSTRAINT "virtual_api_keys_billing_team_id_team_id_fk";
