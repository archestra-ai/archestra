SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_service_account_id_service_accounts_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_accounts"("id") ON DELETE cascade ON UPDATE no action;