-- Existing entries do not track their external catalog preset. Mirror the preset's
-- OAuth requirement for the official Slack endpoint without changing credentials.
UPDATE "internal_mcp_catalog"
SET "oauth_config" = jsonb_set("oauth_config", '{requires_client_credentials}', 'true')
WHERE "server_type" = 'remote'
  AND "aws_iam_config" IS NULL
  AND "enterprise_managed_config" IS NULL
  AND jsonb_typeof("oauth_config") = 'object'
  AND coalesce("oauth_config"->>'grant_type', 'authorization_code') = 'authorization_code'
  AND NOT "oauth_config" ? 'requires_client_credentials'
  AND lower(substring("server_url" from '^([^/?#]+://[^/?#]+)')) ~ '^https://mcp[.]slack[.]com(:0*443)?$'
  AND substring("server_url" from '^[^/?#]+://[^/?#]+([^?#]*)') IN ('/mcp', '/mcp/');
