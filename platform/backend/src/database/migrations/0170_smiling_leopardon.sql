ALTER TABLE "organization" DROP CONSTRAINT "organization_embedding_api_key_secret_id_secret_id_fk";
--> statement-breakpoint
ALTER TABLE "organization" ALTER COLUMN "embedding_model" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "embedding_chat_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "reranker_chat_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "reranker_model" text;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_embedding_chat_api_key_id_chat_api_keys_id_fk" FOREIGN KEY ("embedding_chat_api_key_id") REFERENCES "public"."chat_api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_reranker_chat_api_key_id_chat_api_keys_id_fk" FOREIGN KEY ("reranker_chat_api_key_id") REFERENCES "public"."chat_api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "embedding_api_key_secret_id";