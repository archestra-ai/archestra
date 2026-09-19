-- Revert the openappa_offer_owners table added in 0479.
--
-- Offer routing now travels as signed plaintext claims on the denial notice
-- and execute_remedy_plan call. The event log remains the spend authority.
-- No runtime path reads or writes this table.
--
-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The only code that read or wrote this table
-- (NAPI offer-owner insert/lookup) is removed in this same change. There is
-- no reader to strand during a rolling deploy. host_keys is unchanged.
--
-- No CASCADE: nothing references this table. Drop the indexes first, then the
-- table. An unexpected dependant should fail loudly rather than be dropped.
DROP INDEX "openappa_offer_owners_session_idx";--> statement-breakpoint
DROP INDEX "openappa_offer_owners_root_idx";--> statement-breakpoint
DROP INDEX "openappa_offer_owners_created_at_idx";--> statement-breakpoint
DROP TABLE "openappa_offer_owners";
