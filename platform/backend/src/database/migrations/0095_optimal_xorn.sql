CREATE TABLE "conversation_enabled_tools" (
	"conversation_id" uuid NOT NULL,
	"tool_id" uuid NOT NULL,
	CONSTRAINT "conversation_enabled_tools_conversation_id_tool_id_pk" PRIMARY KEY("conversation_id","tool_id")
);
--> statement-breakpoint
ALTER TABLE "conversation_enabled_tools" ADD CONSTRAINT "conversation_enabled_tools_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_enabled_tools" ADD CONSTRAINT "conversation_enabled_tools_tool_id_tools_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."tools"("id") ON DELETE cascade ON UPDATE no action;