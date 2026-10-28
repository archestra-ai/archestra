ALTER TABLE "agents" ADD COLUMN "model_pool_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "model_pool_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_model_pool_id_model_pools_id_fk" FOREIGN KEY ("model_pool_id") REFERENCES "public"."model_pools"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_model_pool_id_model_pools_id_fk";--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_model_pool_id_model_pools_id_fk" FOREIGN KEY ("model_pool_id") REFERENCES "public"."model_pools"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "conversations" VALIDATE CONSTRAINT "conversations_model_pool_id_model_pools_id_fk";
