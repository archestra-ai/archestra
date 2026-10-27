-- Tell every replica when a row the LLM proxy reads on each request changes,
-- so per-process copies of those rows are dropped. Columns passed as trigger
-- arguments change on hot paths without changing what the proxy reads.
CREATE OR REPLACE FUNCTION archestra_notify_proxy_config() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - TG_ARGV) = (to_jsonb(OLD) - TG_ARGV) THEN
    RETURN NULL;
  END IF;
  PERFORM pg_notify(
    'archestra_proxy_config',
    json_build_object('origin', 'database', 'message', TG_TABLE_NAME)::text
  );
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "agents"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('last_used_at', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "agent_labels"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config();
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "label_keys"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config();
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "label_values"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config();
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "organization"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('updated_at');
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "virtual_api_keys"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('last_used_at', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "virtual_api_key_labels"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config();
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "member"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('updated_at');
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "user"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('updated_at');
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "oauth_access_token"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config();
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "oauth_client"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('updated_at');
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "oauth_client_labels"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config();
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "guardrails_deployment"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('updated_at');
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "resource_permission_policies"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('updated_at');
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "models"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('last_synced_at', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "limits"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('updated_at');
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "environment_default_user_limits"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('updated_at');
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "team"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('updated_at');
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "team_member"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config();
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "team_labels"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config();
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "agent_runs"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('title', 'pinned_at', 'project_id', 'backend', 'runtime_scope', 'active_deadline_seconds', 'attention_state', 'gateway_token_id', 'completion_target', 'completion_notification_claimed_at', 'completion_notified_at', 'logs', 'started_at', 'ended_at', 'created_at', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "agent_workspaces"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('backend', 'runtime_scope', 'active', 'active_task_id', 'last_task_id', 'created_at', 'last_activity_at', 'idle_at', 'expires_at', 'updated_at');
--> statement-breakpoint
CREATE TRIGGER archestra_notify_proxy_config
AFTER INSERT OR UPDATE OR DELETE ON "tools"
FOR EACH ROW EXECUTE FUNCTION archestra_notify_proxy_config('updated_at');
