-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=show_two_factor was a cosmetic frontend-only visibility flag with no enforcement; it is superseded by require_two_factor, which starts false everywhere so no organization's members are locked out by the upgrade. Statements are IF (NOT) EXISTS so environments that applied an earlier revision of this in-review migration converge cleanly.
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "require_two_factor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "session_max_age_seconds" integer;--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN IF EXISTS "show_two_factor";--> statement-breakpoint
-- better-auth's twoFactor plugin requires two_factor.verified; enrollments
-- that predate the column completed verification under the old flow, so mark
-- them verified wherever the user finished enrollment.
ALTER TABLE "two_factor" ADD COLUMN IF NOT EXISTS "verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "two_factor" tf SET "verified" = true
FROM "user" u
WHERE u."id" = tf."user_id" AND u."two_factor_enabled" = true;--> statement-breakpoint
ALTER TABLE "two_factor" ADD COLUMN IF NOT EXISTS "failed_verification_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factor" ADD COLUMN IF NOT EXISTS "locked_until" timestamp;
