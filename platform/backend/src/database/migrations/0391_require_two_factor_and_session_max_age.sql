-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=show_two_factor was a cosmetic frontend-only visibility flag with no enforcement; it is superseded by require_two_factor, which starts false everywhere so no organization's members are locked out by the upgrade.
ALTER TABLE "organization" ADD COLUMN "require_two_factor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "session_max_age_seconds" integer;--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "show_two_factor";
