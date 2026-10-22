-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The foreign keys, index and unique index target tables created empty in this migration, so validation scans no existing rows. ON DELETE CASCADE intentionally removes a pool's members with the pool, and a member when its provider key is deleted; a pool's virtual key grants go with the pool or the virtual key. The interactions columns are nullable without defaults (metadata-only, no index), and lock_timeout bounds the wait for the ACCESS EXCLUSIVE lock so a long transaction on interactions fails this migration instead of stalling the LLM proxy.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "model_pool_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"provider_api_key_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	"priority" integer DEFAULT 1 NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "model_pool_members_pool_key_model_unique" UNIQUE("pool_id","provider_api_key_id","model_id")
);
--> statement-breakpoint
CREATE TABLE "model_pool_virtual_api_keys" (
	"pool_id" uuid NOT NULL,
	"virtual_api_key_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "model_pool_virtual_api_keys_pk" PRIMARY KEY("pool_id","virtual_api_key_id")
);
--> statement-breakpoint
CREATE TABLE "model_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "provider_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "model_pool_id" uuid;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "attempt" integer;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "attempt_outcome" varchar;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "model_pool_members" ADD CONSTRAINT "model_pool_members_pool_id_model_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."model_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_pool_members" ADD CONSTRAINT "model_pool_members_provider_api_key_id_chat_api_keys_id_fk" FOREIGN KEY ("provider_api_key_id") REFERENCES "public"."chat_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_pool_virtual_api_keys" ADD CONSTRAINT "model_pool_virtual_api_keys_pool_id_model_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."model_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_pool_virtual_api_keys" ADD CONSTRAINT "model_pool_virtual_api_keys_virtual_api_key_id_virtual_api_keys_id_fk" FOREIGN KEY ("virtual_api_key_id") REFERENCES "public"."virtual_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_pool_members_provider_api_key_id_idx" ON "model_pool_members" USING btree ("provider_api_key_id");--> statement-breakpoint
CREATE INDEX "model_pool_virtual_api_keys_virtual_api_key_id_idx" ON "model_pool_virtual_api_keys" USING btree ("virtual_api_key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_pools_org_name_unique" ON "model_pools" USING btree ("organization_id","name");