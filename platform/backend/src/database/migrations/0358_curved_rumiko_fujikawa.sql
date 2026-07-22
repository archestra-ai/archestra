CREATE TABLE "chat_tool_execution_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"state" text DEFAULT 'executing' NOT NULL,
	"result" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chat_tool_execution_claims_conversation_id_tool_call_id_unique" UNIQUE("conversation_id","tool_call_id")
);
--> statement-breakpoint
ALTER TABLE "chat_tool_execution_claims" ADD CONSTRAINT "chat_tool_execution_claims_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_tool_execution_claims" VALIDATE CONSTRAINT "chat_tool_execution_claims_conversation_id_conversations_id_fk";
