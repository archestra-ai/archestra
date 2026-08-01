-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=show_two_factor was a cosmetic frontend-only visibility flag with no enforcement; it is superseded by require_two_factor, which starts false everywhere so no organization's members are locked out by the upgrade.
ALTER TABLE "organization" DROP COLUMN "show_two_factor";