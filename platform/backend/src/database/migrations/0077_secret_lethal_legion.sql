ALTER TABLE "internal_mcp_catalog" ADD COLUMN "client_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD COLUMN "local_config_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD CONSTRAINT "internal_mcp_catalog_client_secret_id_secret_id_fk" FOREIGN KEY ("client_secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_mcp_catalog" ADD CONSTRAINT "internal_mcp_catalog_local_config_secret_id_secret_id_fk" FOREIGN KEY ("local_config_secret_id") REFERENCES "public"."secret"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Migration: Move OAuth client_secret from JSONB to secrets table
-- This migration is idempotent and can be run multiple times safely

WITH new_secrets AS (
  INSERT INTO secret (id, name, secret, is_vault, created_at, updated_at)
  SELECT
    gen_random_uuid(),
    id::text || '||' || name || '-oauth-client-secret',
    jsonb_build_object('client_secret', oauth_config->>'client_secret'),
    false,
    NOW(),
    NOW()
  FROM internal_mcp_catalog
  WHERE oauth_config->>'client_secret' IS NOT NULL
    AND client_secret_id IS NULL
  RETURNING id, split_part(name, '||', 1)::uuid as catalog_id
)
UPDATE internal_mcp_catalog
SET
  client_secret_id = new_secrets.id,
  oauth_config = oauth_config - 'client_secret',
  updated_at = NOW()
FROM new_secrets
WHERE internal_mcp_catalog.id = new_secrets.catalog_id;--> statement-breakpoint

-- Clean up temporary catalog IDs from secret names
UPDATE secret
SET name = split_part(name, '||', 2)
WHERE name LIKE '%||%';--> statement-breakpoint

-- Migration: Move secret environment variables from JSONB to secrets table
-- This migration is idempotent and can be run multiple times safely

WITH catalog_with_secrets AS (
  SELECT
    c.id,
    c.name,
    c.local_config,
    jsonb_object_agg(
      elem->>'key',
      elem->>'value'
    ) FILTER (
      WHERE elem->>'type' = 'secret'
        AND elem->>'value' IS NOT NULL
        AND (elem->>'promptOnInstallation')::boolean = false
    ) as secret_env_vars
  FROM internal_mcp_catalog c
  CROSS JOIN LATERAL jsonb_array_elements(c.local_config->'environment') AS elem
  WHERE c.local_config->'environment' IS NOT NULL
    AND c.local_config_secret_id IS NULL
  GROUP BY c.id, c.name, c.local_config
  HAVING COUNT(*) FILTER (
    WHERE elem->>'type' = 'secret'
      AND elem->>'value' IS NOT NULL
      AND (elem->>'promptOnInstallation')::boolean = false
  ) > 0
),
new_secrets AS (
  INSERT INTO secret (id, name, secret, is_vault, created_at, updated_at)
  SELECT
    gen_random_uuid(),
    id::text || '||' || name || '-local-config-env',
    secret_env_vars,
    false,
    NOW(),
    NOW()
  FROM catalog_with_secrets
  RETURNING id, split_part(name, '||', 1)::uuid as catalog_id
)
UPDATE internal_mcp_catalog
SET
  local_config_secret_id = new_secrets.id,
  local_config = jsonb_set(
    local_config,
    '{environment}',
    (
      SELECT jsonb_agg(
        CASE
          -- Only remove value from non-prompted secret-type env vars
          WHEN elem->>'type' = 'secret'
            AND (elem->>'promptOnInstallation')::boolean = false
          THEN elem - 'value'
          -- Keep everything else as-is (including prompted secrets)
          ELSE elem
        END
      )
      FROM jsonb_array_elements(local_config->'environment') AS elem
    )
  ),
  updated_at = NOW()
FROM new_secrets
WHERE internal_mcp_catalog.id = new_secrets.catalog_id;--> statement-breakpoint

-- Clean up temporary catalog IDs from secret names (second pass)
UPDATE secret
SET name = split_part(name, '||', 2)
WHERE name LIKE '%||%';--> statement-breakpoint

