-- MCP gateway tool calls also read their caller's roles, and their tool,
-- catalog and installation rows, through the per-process configuration cache,
-- so changes to those rows drop every replica's copy as well. Columns passed as trigger arguments change
-- on hot paths without changing what a tool call reads.
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "agent_tools"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('updated_at');
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "internal_mcp_catalog"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('updated_at');
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "mcp_server"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('last_used_at', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "apps"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('updated_at');
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "environments"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('updated_at');
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "organization_role"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('updated_at');
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "service_accounts"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('updated_at');
