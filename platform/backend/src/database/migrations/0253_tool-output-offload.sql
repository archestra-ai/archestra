CREATE TABLE "tool_output_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" text,
	"tool_call_id" text,
	"tool_result_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"status" text NOT NULL,
	"raw_input_json" jsonb,
	"raw_output_json" jsonb,
	"raw_output_text" text,
	"size_bytes" integer NOT NULL,
	"estimated_tokens" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tool_output_artifacts" ADD CONSTRAINT "tool_output_artifacts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tool_output_artifacts_conversation_id" ON "tool_output_artifacts" USING btree ("conversation_id");