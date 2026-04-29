CREATE TABLE "virtual_api_key_model_router_api_key" (
	"virtual_api_key_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"chat_api_key_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "virtual_api_key_model_router_api_key_virtual_api_key_id_provider_pk" PRIMARY KEY("virtual_api_key_id","provider")
);
--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ALTER COLUMN "chat_api_key_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ADD COLUMN "organization_id" text;--> statement-breakpoint
UPDATE "virtual_api_keys"
SET "organization_id" = "chat_api_keys"."organization_id"
FROM "chat_api_keys"
WHERE "virtual_api_keys"."chat_api_key_id" = "chat_api_keys"."id";--> statement-breakpoint
ALTER TABLE "virtual_api_keys" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "virtual_api_key_model_router_api_key" ADD CONSTRAINT "virtual_api_key_model_router_api_key_virtual_api_key_id_virtual_api_keys_id_fk" FOREIGN KEY ("virtual_api_key_id") REFERENCES "public"."virtual_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virtual_api_key_model_router_api_key" ADD CONSTRAINT "virtual_api_key_model_router_api_key_chat_api_key_id_chat_api_keys_id_fk" FOREIGN KEY ("chat_api_key_id") REFERENCES "public"."chat_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_virtual_api_key_model_router_api_key_id" ON "virtual_api_key_model_router_api_key" USING btree ("chat_api_key_id");--> statement-breakpoint
CREATE INDEX "idx_virtual_api_key_organization_id" ON "virtual_api_keys" USING btree ("organization_id");
