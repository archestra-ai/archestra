UPDATE oauth_client SET scopes = array_append(scopes, 'a2a')
WHERE 'mcp' = ANY(scopes) AND NOT 'a2a' = ANY(scopes);
--> statement-breakpoint
-- The old mcp scope also authorized A2A, including dynamic registrations.
-- This versioned step runs only once; fresh mcp-only tokens remain narrow.
UPDATE oauth_access_token AS grant_row SET scopes = array_append(grant_row.scopes, 'a2a')
FROM oauth_client AS client
WHERE grant_row.client_id = client.client_id
  AND 'mcp' = ANY(grant_row.scopes) AND NOT 'a2a' = ANY(grant_row.scopes);
--> statement-breakpoint
UPDATE oauth_refresh_token AS grant_row SET scopes = array_append(grant_row.scopes, 'a2a')
FROM oauth_client AS client
WHERE grant_row.client_id = client.client_id
  AND 'mcp' = ANY(grant_row.scopes) AND NOT 'a2a' = ANY(grant_row.scopes);
--> statement-breakpoint
UPDATE oauth_consent AS grant_row SET scopes = array_append(grant_row.scopes, 'a2a')
FROM oauth_client AS client
WHERE grant_row.client_id = client.client_id
  AND 'mcp' = ANY(grant_row.scopes) AND NOT 'a2a' = ANY(grant_row.scopes);
--> statement-breakpoint
-- Preserve each existing registration; the previous mcp capability included A2A.
UPDATE oauth_client SET scopes = CASE
  WHEN scopes IS NULL THEN CASE metadata->>'type'
    WHEN 'mcp_oauth_client' THEN ARRAY['mcp','a2a']
    ELSE ARRAY['llm:proxy'] END
  WHEN metadata->>'type' = 'mcp_oauth_client' AND 'mcp' = ANY(scopes)
    AND NOT 'a2a' = ANY(scopes) THEN array_append(scopes,'a2a')
  ELSE scopes END
WHERE metadata->>'type' IN ('mcp_oauth_client','llm_oauth_client')
  AND (scopes IS NULL OR (metadata->>'type' = 'mcp_oauth_client'
    AND 'mcp' = ANY(scopes) AND NOT 'a2a' = ANY(scopes)));
-- Role actions and scoped policies convert together at startup, after the
-- earlier visibility/legacy-action cutover has captured their old authority.
