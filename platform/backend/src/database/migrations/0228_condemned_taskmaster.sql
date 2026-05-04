ALTER TABLE "internal_mcp_catalog" ADD COLUMN "multitenant" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "team_member_team_id_user_id_idx" ON "team_member" USING btree ("team_id","user_id");--> statement-breakpoint
CREATE INDEX "team_member_user_id_team_id_idx" ON "team_member" USING btree ("user_id","team_id");