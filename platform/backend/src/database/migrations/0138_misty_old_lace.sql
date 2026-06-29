CREATE TABLE "mcp_http_sessions" (
	"connection_key" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
