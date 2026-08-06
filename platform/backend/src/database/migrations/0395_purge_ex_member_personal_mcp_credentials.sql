-- Purge personal MCP installs whose owner is no longer a member of the
-- organization the install belongs to, and the credential rows they hold.
--
-- Removing a member (better-auth `remove-member` / `leave`) used to delete
-- only the `member` row: the user row survived, and with it every personal
-- install — OAuth tokens and prompted secrets included — for an organization
-- the person can no longer access. The runtime now cleans these up on
-- membership removal; this migration sweeps the residue that already exists.
--
-- Scope: `mcp_server.scope = 'personal'` installs with a live owner
-- (`owner_id IS NOT NULL` — ownerless orphans were already purged) whose
-- catalog carries an `organization_id` the owner has no `member` row for.
-- Installs on catalogs WITHOUT an organization_id (legacy/system-seeded,
-- globally visible) are left alone: they cannot be attributed to an
-- organization the owner left.
--
-- Personal APPS backed by a targeted install are deleted the way the Apps
-- lifecycle does it — the app row, its backing catalog, and the catalog's
-- launch tools are soft-deleted (mirroring AppModel.delete + deleteAppBacking)
-- before the install rows are hard-deleted. Without this, dropping the backing
-- server would leave the app detached (`apps.mcp_server_id` only nulls) with a
-- fully live catalog and launch tool.
--
-- Vault / BYOS-vault secrets are RETAINED, exactly as in the ownerless-orphan
-- purge: SQL cannot reach the material in Vault, and the row is the only
-- remaining pointer for purging it there. K8s deployments of purged local
-- installs cannot be torn down from SQL; the runtime reconciler removes
-- deployments whose backing row is gone.
UPDATE "apps"
SET "deleted_at" = now()
WHERE "deleted_at" IS NULL
  AND "mcp_server_id" IN (
    SELECT m."id" FROM "mcp_server" m
    JOIN "internal_mcp_catalog" c ON c."id" = m."catalog_id"
    WHERE m."scope" = 'personal'
      AND m."owner_id" IS NOT NULL
      AND c."organization_id" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "member" mem
        WHERE mem."user_id" = m."owner_id"
          AND mem."organization_id" = c."organization_id"
      )
  );
--> statement-breakpoint
-- App backing catalogs (each backs exactly one app) and their launch tools.
-- Non-app catalogs are shared registry entries serving other users and are
-- NOT touched.
UPDATE "tools"
SET "deleted_at" = now()
WHERE "deleted_at" IS NULL
  AND "catalog_id" IN (
    SELECT m."catalog_id" FROM "mcp_server" m
    JOIN "internal_mcp_catalog" c ON c."id" = m."catalog_id"
    WHERE m."server_type" = 'app'
      AND m."scope" = 'personal'
      AND m."owner_id" IS NOT NULL
      AND c."organization_id" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "member" mem
        WHERE mem."user_id" = m."owner_id"
          AND mem."organization_id" = c."organization_id"
      )
  );
--> statement-breakpoint
UPDATE "internal_mcp_catalog" c
SET "deleted_at" = now()
WHERE c."deleted_at" IS NULL
  AND c."id" IN (
    SELECT m."catalog_id" FROM "mcp_server" m
    JOIN "internal_mcp_catalog" c2 ON c2."id" = m."catalog_id"
    WHERE m."server_type" = 'app'
      AND m."scope" = 'personal'
      AND m."owner_id" IS NOT NULL
      AND c2."organization_id" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "member" mem
        WHERE mem."user_id" = m."owner_id"
          AND mem."organization_id" = c2."organization_id"
      )
  );
--> statement-breakpoint
-- Install-first, capturing `secret_id` as we go — `mcp_server.secret_id` is
-- `ON DELETE SET NULL`, so deleting the secret first would erase the pointer.
-- Vault-backed installs keep their secret row (see header).
WITH purged AS (
  DELETE FROM "mcp_server" m
  WHERE m."scope" = 'personal'
    AND m."owner_id" IS NOT NULL
    AND m."catalog_id" IN (
      SELECT c."id" FROM "internal_mcp_catalog" c
      WHERE c."organization_id" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "member" mem
          WHERE mem."user_id" = m."owner_id"
            AND mem."organization_id" = c."organization_id"
        )
    )
  RETURNING m."secret_id"
)
DELETE FROM "secret" s
WHERE s."id" IN (SELECT "secret_id" FROM purged WHERE "secret_id" IS NOT NULL)
  AND s."is_vault" = false
  AND s."is_byos_vault" = false;
