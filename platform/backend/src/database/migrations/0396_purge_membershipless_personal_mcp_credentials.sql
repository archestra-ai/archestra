-- Purge personal MCP installs whose owner has no organization membership at
-- all, and the credential rows they hold.
--
-- The previous sweep attributed installs to an organization through their
-- catalog's `organization_id` and deliberately skipped catalogs without one.
-- That predicate was too conservative: seeded system catalogs (the built-in
-- Archestra catalog, the chat browser-automation catalog) and other
-- pre-stamping legacy catalogs carry no `organization_id`, so ex-members'
-- personal installs on them survived. Deployments are single-tenant, and the
-- runtime path agrees: a membership removal that leaves the user with no
-- memberships performs a FULL user cleanup with no organization filter. This
-- migration mirrors that runtime semantics for the residue that predates it:
-- an owner with zero `member` rows can reach nothing, so every personal
-- install they own is unreachable credential residue regardless of which
-- catalog it sits on.
--
-- User rows themselves are left alone — without memberships or credentials
-- they hold nothing, and deleting accounts from SQL risks sweeping a user
-- mid-signup whose membership has not been written yet.
--
-- Personal APPS backed by a targeted install are deleted the way the Apps
-- lifecycle does it (app row, backing catalog, launch tools soft-deleted)
-- before the install rows are hard-deleted, exactly as in the previous sweep.
-- Vault / BYOS-vault secrets are RETAINED: SQL cannot reach the material in
-- the backing store, and the row is the only remaining pointer for purging it
-- there. K8s deployments of purged local installs are reconciled away by the
-- runtime, not SQL.
UPDATE "apps"
SET "deleted_at" = now()
WHERE "deleted_at" IS NULL
  AND "mcp_server_id" IN (
    SELECT m."id" FROM "mcp_server" m
    WHERE m."scope" = 'personal'
      AND m."owner_id" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "member" mem WHERE mem."user_id" = m."owner_id"
      )
  );
--> statement-breakpoint
-- App backing catalogs (each backs exactly one app) and their launch tools.
-- Non-app catalogs — including the seeded system catalogs — serve other users
-- and are NOT touched; only their targeted install rows go.
UPDATE "tools"
SET "deleted_at" = now()
WHERE "deleted_at" IS NULL
  AND "catalog_id" IN (
    SELECT m."catalog_id" FROM "mcp_server" m
    WHERE m."server_type" = 'app'
      AND m."scope" = 'personal'
      AND m."owner_id" IS NOT NULL
      AND m."catalog_id" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "member" mem WHERE mem."user_id" = m."owner_id"
      )
  );
--> statement-breakpoint
UPDATE "internal_mcp_catalog" c
SET "deleted_at" = now()
WHERE c."deleted_at" IS NULL
  AND c."id" IN (
    SELECT m."catalog_id" FROM "mcp_server" m
    WHERE m."server_type" = 'app'
      AND m."scope" = 'personal'
      AND m."owner_id" IS NOT NULL
      AND m."catalog_id" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "member" mem WHERE mem."user_id" = m."owner_id"
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
    AND NOT EXISTS (
      SELECT 1 FROM "member" mem WHERE mem."user_id" = m."owner_id"
    )
  RETURNING m."secret_id"
)
DELETE FROM "secret" s
WHERE s."id" IN (SELECT "secret_id" FROM purged WHERE "secret_id" IS NOT NULL)
  AND s."is_vault" = false
  AND s."is_byos_vault" = false;
