CREATE TABLE "virtual_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_api_key_id" uuid NOT NULL,
	"name" varchar(256) NOT NULL,
	"secret_id" uuid NOT NULL,
	"token_start" varchar(16) NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp
);
--> statement-breakpoint
DROP INDEX "chat_api_keys_personal_unique";--> statement-breakpoint
DROP INDEX "chat_api_keys_team_unique";--> statement-breakpoint
DROP INDEX "chat_api_keys_org_wide_unique";--> statement-breakpoint
ALTER TABLE "chat_api_keys" ADD COLUMN "base_url" text;--> statement-breakpoint
ALTER TABLE "chat_api_keys" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ADD CONSTRAINT "virtual_api_keys_chat_api_key_id_chat_api_keys_id_fk" FOREIGN KEY ("chat_api_key_id") REFERENCES "public"."chat_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ADD CONSTRAINT "virtual_api_keys_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_virtual_api_key_chat_api_key_id" ON "virtual_api_keys" USING btree ("chat_api_key_id");