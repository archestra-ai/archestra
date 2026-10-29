-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=guardrails_deployment holds one row and both columns are added in this file with no values, so no row can violate the new foreign keys
ALTER TABLE "guardrails_deployment" ADD COLUMN "annotator_model_id" uuid;--> statement-breakpoint
ALTER TABLE "guardrails_deployment" ADD COLUMN "annotator_llm_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "guardrails_deployment" ADD CONSTRAINT "guardrails_deployment_annotator_model_id_models_id_fk" FOREIGN KEY ("annotator_model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrails_deployment" ADD CONSTRAINT "guardrails_deployment_annotator_llm_api_key_id_chat_api_keys_id_fk" FOREIGN KEY ("annotator_llm_api_key_id") REFERENCES "public"."chat_api_keys"("id") ON DELETE set null ON UPDATE no action;