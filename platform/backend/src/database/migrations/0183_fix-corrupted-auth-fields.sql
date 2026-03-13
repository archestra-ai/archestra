-- Fix corrupted data created by Archestra MCP server tools that bypassed
-- Zod validation via unsafe `as` type casts. Three Sentry errors:
--   BACKEND-5Y / FRONTEND-1H: GET /api/internal_mcp_catalog 500 (authFields missing "required")
--   FRONTEND-1R: GET /mcp/tool-policies 500 (invalid action or conditions)

-- 1. Fix authFields entries missing the "required" boolean field.
--    Add "required": false to any authFields entry missing it.
UPDATE internal_mcp_catalog
SET auth_fields = (
  SELECT jsonb_agg(
    CASE
      WHEN NOT (elem ? 'required') THEN elem || '{"required": false}'::jsonb
      ELSE elem
    END
  )
  FROM jsonb_array_elements(auth_fields) AS elem
)
WHERE auth_fields IS NOT NULL
  AND auth_fields != '[]'::jsonb
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(auth_fields) AS elem
    WHERE NOT (elem ? 'required')
  );

-- 2. Delete tool_invocation_policies rows with invalid action values.
--    Valid actions defined at the DB/API level (require_approval is a valid DB value
--    but not exposed in the MCP tool's inputSchema which only lists the first three).
DELETE FROM tool_invocation_policies
WHERE action NOT IN (
  'allow_when_context_is_untrusted',
  'block_when_context_is_untrusted',
  'block_always',
  'require_approval'
);

-- 3. Delete tool_invocation_policies rows with malformed conditions JSONB.
--    Each condition must have key (string), operator (valid enum), value (string).
DELETE FROM tool_invocation_policies
WHERE conditions IS NOT NULL
  AND conditions != '[]'::jsonb
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(conditions) AS elem
    WHERE NOT (
      elem ? 'key'
      AND elem ? 'operator'
      AND elem ? 'value'
      AND jsonb_typeof(elem->'key') = 'string'
      AND jsonb_typeof(elem->'operator') = 'string'
      AND jsonb_typeof(elem->'value') = 'string'
      AND elem->>'operator' IN ('equal', 'notEqual', 'contains', 'notContains', 'startsWith', 'endsWith', 'regex')
    )
  );

-- 4. Delete trusted_data_policies rows with invalid action values.
--    Valid actions: block_always, mark_as_trusted, mark_as_untrusted, sanitize_with_dual_llm
DELETE FROM trusted_data_policies
WHERE action NOT IN (
  'block_always',
  'mark_as_trusted',
  'mark_as_untrusted',
  'sanitize_with_dual_llm'
);

-- 5. Delete trusted_data_policies rows with malformed conditions JSONB.
DELETE FROM trusted_data_policies
WHERE conditions IS NOT NULL
  AND conditions != '[]'::jsonb
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(conditions) AS elem
    WHERE NOT (
      elem ? 'key'
      AND elem ? 'operator'
      AND elem ? 'value'
      AND jsonb_typeof(elem->'key') = 'string'
      AND jsonb_typeof(elem->'operator') = 'string'
      AND jsonb_typeof(elem->'value') = 'string'
      AND elem->>'operator' IN ('equal', 'notEqual', 'contains', 'notContains', 'startsWith', 'endsWith', 'regex')
    )
  );
