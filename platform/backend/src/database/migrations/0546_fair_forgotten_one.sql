SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "gateway_token_id" uuid;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_gateway_token_id_service_account_tokens_id_fk" FOREIGN KEY ("gateway_token_id") REFERENCES "public"."service_account_tokens"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action NOT VALID;