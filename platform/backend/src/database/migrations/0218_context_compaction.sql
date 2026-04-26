CREATE TABLE "conversation_compactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"compacted_message_count" integer NOT NULL,
	"summary" text NOT NULL,
	"compacted_message_ids" jsonb NOT NULL,
	"created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "conversation_compactions" ADD CONSTRAINT "conversation_compactions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "conversation_compactions_conversation_id_idx" ON "conversation_compactions" USING btree ("conversation_id");
