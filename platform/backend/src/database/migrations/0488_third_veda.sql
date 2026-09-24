-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=The new key (organization_id, actor) widens the old actor-only primary key, so every existing row, unique by actor, is already unique under it and the constraint cannot fail. organization_id is already NOT NULL. The rebuilt index covers one row per OpenAPPA session, a small table.
ALTER TABLE "openappa_sessions" DROP CONSTRAINT "openappa_sessions_pkey";--> statement-breakpoint
ALTER TABLE "openappa_sessions" ADD CONSTRAINT "openappa_sessions_organization_id_actor_pk" PRIMARY KEY("organization_id","actor");
