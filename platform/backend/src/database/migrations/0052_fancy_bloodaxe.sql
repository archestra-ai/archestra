ALTER TABLE "mcp_server" ALTER COLUMN "server_type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "consider_context_untrusted" boolean DEFAULT false NOT NULL;