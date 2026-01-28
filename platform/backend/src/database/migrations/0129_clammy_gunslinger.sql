CREATE TABLE "api_key_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_key_id" uuid NOT NULL,
	"model_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_models_unique" UNIQUE("api_key_id","model_id")
);
--> statement-breakpoint
ALTER TABLE "chat_api_keys" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "api_key_models" ADD CONSTRAINT "api_key_models_api_key_id_chat_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."chat_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_models" ADD CONSTRAINT "api_key_models_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_models_api_key_id_idx" ON "api_key_models" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "api_key_models_model_id_idx" ON "api_key_models" USING btree ("model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_api_keys_system_unique" ON "chat_api_keys" USING btree ("provider") WHERE "chat_api_keys"."is_system" = true;