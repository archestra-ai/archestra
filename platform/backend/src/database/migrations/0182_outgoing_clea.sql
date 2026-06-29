CREATE INDEX "idx_team_token_token_start" ON "team_token" USING btree ("token_start");--> statement-breakpoint
CREATE INDEX "idx_user_token_token_start" ON "user_token" USING btree ("token_start");