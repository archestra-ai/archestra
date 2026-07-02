-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The skills-as-slash-commands org toggle is retired: slash commands are now always available whenever the org's skill tools are enabled, and every code path reading this column is removed in the same change, so losing the stored preference bit is intentional and nothing left reads it.
ALTER TABLE "organization" DROP COLUMN "skill_slash_commands_enabled";
