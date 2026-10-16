ALTER TABLE "service_accounts" ADD COLUMN "team_id" text;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "service_accounts" VALIDATE CONSTRAINT "service_accounts_team_id_team_id_fk";--> statement-breakpoint
CREATE INDEX "service_accounts_team_id_idx" ON "service_accounts" USING btree ("team_id");
