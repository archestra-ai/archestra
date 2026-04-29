CREATE TABLE "memory_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"content" text NOT NULL,
	"created_by" text,
	"reviewed_by" text,
	"reviewed_at" timestamp,
	"rejection_reason" text,
	"rejection_comment" text,
	"extractor_version" text,
	"policy_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_type" text,
	"source_id" text,
	"source_metadata" jsonb,
	"source_conversation_id" uuid,
	"source_message_ids" uuid[],
	"supersedes_memory_id" uuid,
	"confidence_band" text,
	"language" text,
	"last_verified_at" timestamp,
	"expires_at" timestamp,
	"scores" jsonb,
	"classifications" jsonb,
	"scorer_version" text,
	"last_retrieved_at" timestamp,
	"retrieval_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_tombstone" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"reason" text NOT NULL,
	"expires_at" timestamp DEFAULT now() + interval '30 days',
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "memory_extraction_status" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "memory_extracted_at" timestamp;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "memory_extraction_attempted_at" timestamp;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_extraction_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_injection_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_idle_delay_seconds" integer DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_extractor_max_tokens" integer DEFAULT 800 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_extractor_model" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_extractor_prompt" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_extractor_chat_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_injection_token_budget" integer DEFAULT 600 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_injection_top_k" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_tombstone_ttl_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_candidate_ttl_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_max_content_length" integer DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "memory_max_candidates_per_extraction" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_item" ADD CONSTRAINT "memory_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_item" ADD CONSTRAINT "memory_item_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_item" ADD CONSTRAINT "memory_item_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_item" ADD CONSTRAINT "memory_item_source_conversation_id_conversations_id_fk" FOREIGN KEY ("source_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_item" ADD CONSTRAINT "memory_item_supersedes_memory_id_memory_item_id_fk" FOREIGN KEY ("supersedes_memory_id") REFERENCES "public"."memory_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_tombstone" ADD CONSTRAINT "memory_tombstone_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_items_org_scope_status_idx" ON "memory_item" USING btree ("organization_id","scope_type","scope_id","status");--> statement-breakpoint
CREATE INDEX "memory_items_org_status_created_idx" ON "memory_item" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "memory_items_source_conversation_idx" ON "memory_item" USING btree ("source_conversation_id");--> statement-breakpoint
CREATE INDEX "memory_items_source_type_idx" ON "memory_item" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "memory_items_source_type_id_idx" ON "memory_item" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "memory_items_approved_scope_idx" ON "memory_item" USING btree ("organization_id","scope_type","scope_id") WHERE "memory_item"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "memory_items_supersedes_memory_idx" ON "memory_item" USING btree ("supersedes_memory_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_tombstones_scope_hash_uk" ON "memory_tombstone" USING btree ("organization_id","scope_type","scope_id","content_hash");--> statement-breakpoint
CREATE INDEX "memory_tombstones_expires_at_idx" ON "memory_tombstone" USING btree ("expires_at");