CREATE TABLE "openappa_unenforced_calls" (
	"organization_id" text NOT NULL,
	"session_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"reason" text NOT NULL,
	"child_native_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openappa_unenforced_calls_organization_id_session_id_tool_call_id_pk" PRIMARY KEY("organization_id","session_id","tool_call_id")
);
--> statement-breakpoint
CREATE TABLE "openappa_unenforced_sessions" (
	"organization_id" text NOT NULL,
	"session_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "openappa_unenforced_sessions_organization_id_session_id_pk" PRIMARY KEY("organization_id","session_id")
);
