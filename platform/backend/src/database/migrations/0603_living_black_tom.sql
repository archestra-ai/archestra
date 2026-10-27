-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=This is an intentional 1.5 breaking schema removal; stop application processes for the upgrade. The secret-table lock and populated-payload guard preserve credentials before removing the discriminator. No remote secret store is accessed.
-- Do not drop a storage discriminator while populated payloads depend on it.
-- Payloads can be encrypted, and older writers could mislabel real credentials.
-- Abort before changing schema or data rather than interpreting or clearing them.
DO $$
BEGIN
  -- Older migration histories can commit the migrator's outer transaction.
  -- One statement keeps the lock, guard and schema changes atomic either way.
  LOCK TABLE "secret" IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (
    SELECT 1 FROM "secret"
    WHERE "is_byos_vault" = true AND "is_vault" = false AND "secret" <> '{}'::jsonb
  ) THEN
    RAISE EXCEPTION 'Secret storage needs reconfiguration before this upgrade. No credentials or schema were changed.';
  END IF;
  DROP TABLE "team_vault_folder";
  ALTER TABLE "secret" DROP COLUMN "is_byos_vault";
END $$;
