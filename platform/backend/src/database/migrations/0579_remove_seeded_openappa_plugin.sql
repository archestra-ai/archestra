-- OpenAPPA now runs inside the gateway and the LLM proxy, so the Claude Code
-- plugin that older releases imported into every organization is redundant.
-- Its MCP server points at a local runtime that is no longer installed, so
-- Claude Code reports it as a failed connection. Soft-delete it the same way
-- PluginModel.delete does: it leaves the Connect page and the marketplace
-- served to clients, and its history stays intact.
UPDATE "plugins"
SET
  "deleted_at" = now(),
  "enabled" = false,
  "github_sync_interval" = NULL,
  "github_app_config_id" = NULL,
  "github_pat_id" = NULL,
  "gitlab_token_id" = NULL,
  "pending_source_sha" = NULL,
  "pending_content_hash" = NULL,
  "pending_detected_at" = NULL,
  "sync_generation" = "sync_generation" + 1,
  "updated_at" = now()
WHERE "deleted_at" IS NULL
  AND (
    "source_id" = 'managed:openappa:claude-code'
    OR (
      lower("source_marketplace_repo") = 'archestra-ai/openappa'
      AND lower("source_marketplace_plugin_name") = 'appa-runtime'
    )
  );
