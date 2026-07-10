-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=All flagged statements (FK constraints, unique index) target chatops_thread_conversations, the brand-new empty table created in this same migration. There are no existing rows to fail validation and no older writers to break; the constraints are part of the table's initial contract.
CREATE TABLE "chatops_thread_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"thread_id" varchar(256) NOT NULL,
	"conversation_id" uuid NOT NULL,
	"last_synced_provider_ts" varchar(256),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chatops_thread_conversations" ADD CONSTRAINT "chatops_thread_conversations_binding_id_chatops_channel_binding_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."chatops_channel_binding"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chatops_thread_conversations" ADD CONSTRAINT "chatops_thread_conversations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chatops_thread_conversations_binding_thread_idx" ON "chatops_thread_conversations" USING btree ("binding_id","thread_id");--> statement-breakpoint
CREATE INDEX "chatops_thread_conversations_conversation_id_idx" ON "chatops_thread_conversations" USING btree ("conversation_id");