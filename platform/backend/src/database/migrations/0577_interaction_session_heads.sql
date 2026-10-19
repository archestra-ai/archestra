-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Creates two new, empty tables with their indexes (no rewrite of an existing table) and adds two triggers on interactions. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on interactions: it waits for in-flight interaction writes and blocks new ones until this transaction commits. It is O(1) catalog work issued last, and lock_timeout bounds the wait, so a long-running transaction on interactions fails this migration (retried on the next deploy) instead of stalling the LLM proxy. History is folded into the head table by a batched startup backfill, never in this transaction.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "interaction_session_heads_backfill" (
	"id" integer PRIMARY KEY NOT NULL,
	"after_id" uuid
);
--> statement-breakpoint
CREATE TABLE "interaction_session_heads" (
	"sessionless" boolean NOT NULL,
	"session_key" varchar NOT NULL,
	"last_created_at" timestamp NOT NULL,
	"last_interaction_id" uuid NOT NULL,
	"user_id" text,
	CONSTRAINT "interaction_session_heads_sessionless_session_key_pk" PRIMARY KEY("sessionless","session_key")
);
--> statement-breakpoint
CREATE INDEX "interaction_session_heads_last_idx" ON "interaction_session_heads" USING btree ("last_created_at" DESC NULLS LAST,"last_interaction_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "interaction_session_heads_user_last_idx" ON "interaction_session_heads" USING btree ("user_id","last_created_at" DESC NULLS LAST,"last_interaction_id" DESC NULLS LAST);
--> statement-breakpoint
-- Interactions written before this table existed are folded in by the startup
-- backfill. Readers keep scanning interactions while this marker exists. An
-- empty interactions table (fresh install) has nothing to backfill.
INSERT INTO "interaction_session_heads_backfill" ("id") SELECT 1 WHERE EXISTS (SELECT 1 FROM "interactions");
--> statement-breakpoint
-- ON CONFLICT DO UPDATE locks the head row and re-checks the WHERE against its
-- latest committed version, so two writers racing on one session leave the
-- newer (created_at, id) in place whichever of them commits last.
CREATE FUNCTION interaction_session_heads_on_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO interaction_session_heads AS head (sessionless, session_key, last_created_at, last_interaction_id, user_id)
  VALUES (NEW.session_id IS NULL, COALESCE(NEW.session_id, NEW.id::text), NEW.created_at, NEW.id, NEW.user_id)
  ON CONFLICT (sessionless, session_key) DO UPDATE
    SET last_created_at = excluded.last_created_at,
        last_interaction_id = excluded.last_interaction_id,
        user_id = excluded.user_id
    WHERE (excluded.last_created_at, excluded.last_interaction_id) > (head.last_created_at, head.last_interaction_id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- Retention removes heads: an expired session's newest row is a leaf, so it
-- goes first. Move each removed head to the newest surviving row of its
-- session, or drop it when nothing survives.
CREATE FUNCTION interaction_session_heads_on_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH gone AS (
    SELECT DISTINCT head.sessionless, head.session_key
    FROM removed
    JOIN interaction_session_heads head
      ON head.sessionless = (removed.session_id IS NULL)
     AND head.session_key = COALESCE(removed.session_id, removed.id::text)
     AND head.last_interaction_id = removed.id
  ), survivor AS (
    SELECT gone.sessionless, gone.session_key, latest.id, latest.created_at, latest.user_id
    FROM gone
    LEFT JOIN LATERAL (
      SELECT i.id, i.created_at, i.user_id FROM interactions i
      WHERE NOT gone.sessionless AND i.session_id = gone.session_key
      ORDER BY i.created_at DESC NULLS LAST, i.id DESC
      LIMIT 1
    ) latest ON true
  ), dropped AS (
    DELETE FROM interaction_session_heads head
    USING survivor
    WHERE survivor.id IS NULL
      AND head.sessionless = survivor.sessionless AND head.session_key = survivor.session_key
  )
  UPDATE interaction_session_heads head
  SET last_created_at = survivor.created_at, last_interaction_id = survivor.id, user_id = survivor.user_id
  FROM survivor
  WHERE survivor.id IS NOT NULL
    AND head.sessionless = survivor.sessionless AND head.session_key = survivor.session_key;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER interaction_session_heads_inserted AFTER INSERT ON interactions FOR EACH ROW EXECUTE FUNCTION interaction_session_heads_on_insert();
--> statement-breakpoint
CREATE TRIGGER interaction_session_heads_deleted AFTER DELETE ON interactions REFERENCING OLD TABLE AS removed FOR EACH STATEMENT EXECUTE FUNCTION interaction_session_heads_on_delete();
