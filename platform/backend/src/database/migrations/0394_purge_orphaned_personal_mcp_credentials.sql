-- Purge personal MCP installs whose owner was already deleted, and the
-- credential rows they hold.
--
-- `mcp_server.owner_id` is `ON DELETE SET NULL`, so every user deleted before
-- the cleanup in `UserModel.delete` left their personal install behind:
-- ownerless, unreachable (the `mcp_server_user` rows cascaded away with the
-- user), unrestorable, and still holding OAuth tokens / prompted secrets in
-- its `secret` row. The `secret` table has no user FK, so nothing reclaimed it.
--
-- `scope = 'personal'` is the discriminator, NOT `owner_id` on its own:
-- org- and team-scoped installs legitimately have no owner and must survive.
-- `scope` is NOT NULL with default 'personal', so no COALESCE fallback is
-- needed for legacy rows.
--
-- Soft-deleted installs are included deliberately. Uninstall retains the
-- secret bag so a restore can recover stored credentials; with the owner gone
-- nobody can restore it, so the retained row is pure credential residue.

-- Vault-backed secrets are handled separately below, so exclude their installs
-- from this pass and delete the rest install-first, capturing `secret_id` as we
-- go — `mcp_server.secret_id` is `ON DELETE SET NULL`, so deleting the secret
-- first would erase the pointer before we could follow it.
WITH purged AS (
  DELETE FROM "mcp_server" m
  WHERE m."scope" = 'personal'
    AND m."owner_id" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "secret" s
      WHERE s."id" = m."secret_id"
        AND (s."is_vault" = true OR s."is_byos_vault" = true)
    )
  RETURNING m."secret_id"
)
DELETE FROM "secret"
WHERE "id" IN (SELECT "secret_id" FROM purged WHERE "secret_id" IS NOT NULL);
--> statement-breakpoint
-- Vault / BYOS-vault installs: drop the unreachable install, but KEEP its
-- `secret` row. The material lives in Vault, which SQL cannot reach, and that
-- row is the only remaining record of the path needed to purge it there —
-- deleting it would strand the Vault entry with no pointer at all. The
-- retained rows are then findable as secrets referenced by nothing:
--   SELECT s.* FROM "secret" s
--   WHERE NOT EXISTS (SELECT 1 FROM "mcp_server" m WHERE m."secret_id" = s."id")
--     AND NOT EXISTS (SELECT 1 FROM "internal_mcp_catalog" c WHERE c."local_config_secret_id" = s."id");
DELETE FROM "mcp_server"
WHERE "scope" = 'personal'
  AND "owner_id" IS NULL;
