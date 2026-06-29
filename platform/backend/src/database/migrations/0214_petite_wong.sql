CREATE TABLE "conversation_chat_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"error" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_chat_errors" ADD CONSTRAINT "conversation_chat_errors_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "conversation_chat_errors" ("conversation_id", "error", "created_at")
SELECT "id", "last_chat_error", "updated_at"
FROM "conversations"
WHERE "last_chat_error" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "conversation_chat_errors_conversation_id_idx" ON "conversation_chat_errors" USING btree ("conversation_id");--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "last_chat_error";
