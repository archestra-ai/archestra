-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The new key (organization_id, actor) widens the old actor-only primary key, so every existing row, unique by actor, is already unique under it and the constraint cannot fail. organization_id is already NOT NULL. The rebuilt index covers one row per OpenAPPA session, a small table, and lock_timeout bounds the wait for its exclusive lock so a busy table fails the migration instead of stalling session writes.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "openappa_sessions" DROP CONSTRAINT "openappa_sessions_pkey";--> statement-breakpoint
ALTER TABLE "openappa_sessions" ADD CONSTRAINT "openappa_sessions_organization_id_actor_pk" PRIMARY KEY("organization_id","actor");
