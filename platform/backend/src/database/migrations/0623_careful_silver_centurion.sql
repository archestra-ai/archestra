-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Creates four new, empty tables and adds triggers on interactions and interaction_billing. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on each table: it waits for in-flight writes and blocks new ones until this transaction commits. It is O(1) catalog work issued last, and lock_timeout bounds the wait, so a long-running transaction fails this migration (retried on the next deploy) instead of stalling the LLM proxy. History is rolled up by the periodic llm_usage_rollup task, never in this transaction.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "llm_usage_hourly" (
	"hour" timestamp NOT NULL,
	"profile_id" uuid,
	"connector_id" uuid,
	"app_id" uuid,
	"billing_team_id" text,
	"user_id" text,
	"service_account_id" uuid,
	"auth_method" varchar,
	"virtual_key_id" uuid,
	"passthrough_virtual_key_id" uuid,
	"authenticated_app_id" text,
	"authenticated_app_name" varchar,
	"provider_api_key_id" uuid,
	"model_pool_id" uuid,
	"external_agent_id" varchar,
	"type" varchar NOT NULL,
	"model" varchar,
	"billed_model" varchar,
	"billing_mode" varchar NOT NULL,
	"attribution_labels" jsonb,
	"requests" integer NOT NULL,
	"input_tokens" bigint NOT NULL,
	"reported_input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_read_tokens" bigint NOT NULL,
	"cache_write_tokens" bigint NOT NULL,
	"cost" numeric NOT NULL,
	"baseline_cost" numeric NOT NULL,
	"cache_savings" numeric NOT NULL,
	"failed_over_attempts" integer NOT NULL,
	"max_created_at" timestamp,
	"model_input_tokens" bigint NOT NULL,
	"model_reported_input_tokens" bigint NOT NULL,
	"model_output_tokens" bigint NOT NULL,
	"model_cache_read_tokens" bigint NOT NULL,
	"model_cache_write_tokens" bigint NOT NULL,
	"model_cost" numeric NOT NULL,
	"model_baseline_cost" numeric NOT NULL,
	"model_cache_savings" numeric NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_usage_rollup_dirty" (
	"hour" timestamp PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"settle_after" bigint
);
--> statement-breakpoint
CREATE TABLE "llm_usage_rollup_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"rolled_through" timestamp
);
--> statement-breakpoint
CREATE INDEX "llm_usage_hourly_hour_idx" ON "llm_usage_hourly" USING btree ("hour");
--> statement-breakpoint
CREATE TABLE "llm_usage_daily" (
	"hour" timestamp NOT NULL,
	"profile_id" uuid,
	"connector_id" uuid,
	"app_id" uuid,
	"billing_team_id" text,
	"user_id" text,
	"service_account_id" uuid,
	"auth_method" varchar,
	"virtual_key_id" uuid,
	"passthrough_virtual_key_id" uuid,
	"authenticated_app_id" text,
	"authenticated_app_name" varchar,
	"provider_api_key_id" uuid,
	"model_pool_id" uuid,
	"external_agent_id" varchar,
	"type" varchar NOT NULL,
	"model" varchar,
	"billed_model" varchar,
	"billing_mode" varchar NOT NULL,
	"attribution_labels" jsonb,
	"requests" integer NOT NULL,
	"input_tokens" bigint NOT NULL,
	"reported_input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_read_tokens" bigint NOT NULL,
	"cache_write_tokens" bigint NOT NULL,
	"cost" numeric NOT NULL,
	"baseline_cost" numeric NOT NULL,
	"cache_savings" numeric NOT NULL,
	"failed_over_attempts" integer NOT NULL,
	"max_created_at" timestamp,
	"model_input_tokens" bigint NOT NULL,
	"model_reported_input_tokens" bigint NOT NULL,
	"model_output_tokens" bigint NOT NULL,
	"model_cache_read_tokens" bigint NOT NULL,
	"model_cache_write_tokens" bigint NOT NULL,
	"model_cost" numeric NOT NULL,
	"model_baseline_cost" numeric NOT NULL,
	"model_cache_savings" numeric NOT NULL
);
--> statement-breakpoint
CREATE INDEX "llm_usage_daily_hour_idx" ON "llm_usage_daily" USING btree ("hour");

--> statement-breakpoint
-- Mark an hour for recompute. Bumps the version (never DO NOTHING): the rollup
-- clears a mark only while its version is unchanged, so a change that races a
-- recompute keeps its mark. A mark this transaction already wrote commits with
-- every change the transaction makes, so a bulk update needs one per hour, not
-- one per row: the transaction remembers the hours it marked (in a setting that
-- a rolled-back savepoint also rolls back), and the row version check covers
-- hours it no longer remembers. Marking an hour again is only extra work.
CREATE FUNCTION llm_usage_rollup_mark_hour(marked timestamp) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  remembered text := COALESCE(current_setting('archestra.llm_usage_rollup_marked', true), '');
  key text := ' ' || extract(epoch FROM marked)::bigint || ' ';
BEGIN
  IF marked IS NULL OR strpos(remembered, key) > 0 THEN
    RETURN;
  END IF;
  INSERT INTO llm_usage_rollup_dirty AS dirty (hour) VALUES (marked)
  ON CONFLICT (hour) DO UPDATE SET version = dirty.version + 1, settle_after = NULL
  WHERE dirty.xmin <> pg_current_xact_id()::xid;
  -- At most a few hundred hours, so each lookup stays cheap.
  IF length(remembered) > 4096 THEN
    remembered := '';
  END IF;
  PERFORM set_config('archestra.llm_usage_rollup_marked', remembered || key, true);
END;
$$;
--> statement-breakpoint
-- Several hours, in order, so concurrent markers take the rows' locks in one
-- order.
CREATE FUNCTION llm_usage_rollup_mark(hours timestamp[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  marked timestamp;
BEGIN
  FOR marked IN SELECT DISTINCT hour FROM unnest(hours) AS hour ORDER BY hour LOOP
    PERFORM llm_usage_rollup_mark_hour(marked);
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION llm_usage_rollup_on_interaction_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM llm_usage_rollup_mark_hour(date_trunc('hour', NEW.created_at));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION llm_usage_rollup_on_interaction_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM llm_usage_rollup_mark_hour(date_trunc('hour', OLD.created_at));
  IF date_trunc('hour', NEW.created_at) <> date_trunc('hour', OLD.created_at) THEN
    PERFORM llm_usage_rollup_mark_hour(date_trunc('hour', NEW.created_at));
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION llm_usage_rollup_on_interaction_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM llm_usage_rollup_mark(ARRAY(SELECT DISTINCT date_trunc('hour', removed.created_at) FROM removed));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION llm_usage_rollup_on_receipt_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM llm_usage_rollup_mark(ARRAY(
    SELECT date_trunc('hour', interactions.created_at) FROM interactions
    WHERE interactions.id IN (OLD.interaction_id, NEW.interaction_id)
  ));
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- An ordinary insert is stamped with its transaction's start and needs no mark:
-- the rollup re-reads every hour once the transactions running when it was
-- computed have ended. A row stamped well before it is written (backdated, or
-- a transaction idle for minutes before its first write) is marked instead.
-- The WHEN clause is evaluated without calling the function.
CREATE TRIGGER llm_usage_rollup_interaction_inserted AFTER INSERT ON interactions FOR EACH ROW
  WHEN (NEW.created_at < clock_timestamp() - interval '5 minutes')
  EXECUTE FUNCTION llm_usage_rollup_on_interaction_insert();
--> statement-breakpoint
-- Column-specific, so updates of request content or session previews never
-- fire it. Foreign-key SET NULL actions are updates of these columns.
CREATE TRIGGER llm_usage_rollup_interaction_updated AFTER UPDATE OF created_at, profile_id, connector_id, app_id, billing_team_id, user_id, service_account_id, auth_method, virtual_key_id, passthrough_virtual_key_id, authenticated_app_id, authenticated_app_name, provider_api_key_id, model_pool_id, external_agent_id, type, model, billing_mode, attribution_labels, input_tokens, input_tokens_estimated, output_tokens, cache_read_tokens, cache_write_tokens, cost, baseline_cost, cache_savings, attempt_outcome ON interactions FOR EACH ROW
  WHEN ((OLD.created_at, OLD.profile_id, OLD.connector_id, OLD.app_id, OLD.billing_team_id, OLD.user_id, OLD.service_account_id, OLD.auth_method, OLD.virtual_key_id, OLD.passthrough_virtual_key_id, OLD.authenticated_app_id, OLD.authenticated_app_name, OLD.provider_api_key_id, OLD.model_pool_id, OLD.external_agent_id, OLD.type, OLD.model, OLD.billing_mode, OLD.attribution_labels, OLD.input_tokens, OLD.input_tokens_estimated, OLD.output_tokens, OLD.cache_read_tokens, OLD.cache_write_tokens, OLD.cost, OLD.baseline_cost, OLD.cache_savings, OLD.attempt_outcome) IS DISTINCT FROM (NEW.created_at, NEW.profile_id, NEW.connector_id, NEW.app_id, NEW.billing_team_id, NEW.user_id, NEW.service_account_id, NEW.auth_method, NEW.virtual_key_id, NEW.passthrough_virtual_key_id, NEW.authenticated_app_id, NEW.authenticated_app_name, NEW.provider_api_key_id, NEW.model_pool_id, NEW.external_agent_id, NEW.type, NEW.model, NEW.billing_mode, NEW.attribution_labels, NEW.input_tokens, NEW.input_tokens_estimated, NEW.output_tokens, NEW.cache_read_tokens, NEW.cache_write_tokens, NEW.cost, NEW.baseline_cost, NEW.cache_savings, NEW.attempt_outcome))
  EXECUTE FUNCTION llm_usage_rollup_on_interaction_update();
--> statement-breakpoint
CREATE TRIGGER llm_usage_rollup_interaction_deleted AFTER DELETE ON interactions REFERENCING OLD TABLE AS removed FOR EACH STATEMENT
  EXECUTE FUNCTION llm_usage_rollup_on_interaction_delete();
--> statement-breakpoint
-- A receipt is written before its interaction in the same transaction (claiming
-- it otherwise fails), so a new receipt has no interaction to mark yet, and
-- receipts are only deleted with their interaction; only a later repricing
-- needs a mark.
CREATE TRIGGER llm_usage_rollup_receipt_updated AFTER UPDATE OF interaction_id, usage, attribution_labels ON interaction_billing FOR EACH ROW
  WHEN ((OLD.interaction_id, OLD.usage, OLD.attribution_labels) IS DISTINCT FROM (NEW.interaction_id, NEW.usage, NEW.attribution_labels))
  EXECUTE FUNCTION llm_usage_rollup_on_receipt_update();
