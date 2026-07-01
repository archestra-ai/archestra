CREATE TABLE "conversation_compactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"compacted_through_message_id" text,
	"trigger" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"original_token_estimate" integer NOT NULL,
	"compacted_token_estimate" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_compactions" ADD CONSTRAINT "conversation_compactions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_compactions_conversation_id_created_at_idx" ON "conversation_compactions" USING btree ("conversation_id","created_at");