CREATE TABLE "tool_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tool_call_id" text NOT NULL,
	"state" text DEFAULT 'executing' NOT NULL,
	"result" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tool_executions_tool_call_id_unique" UNIQUE("tool_call_id")
);
