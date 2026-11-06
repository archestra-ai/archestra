-- Seed a SCRATCH database with about a year of synthetic LLM usage, to time
-- the cost statistics at the scale a large organization reaches.
--
-- Run it with psql against a migrated, empty scratch database whose name
-- starts with "costs_bench", as a superuser (it disables triggers and foreign
-- key checks for the load). See README.md next to it.
--
--   psql "$URL" -v interactions=20000000 -f seed.sql
--
-- Every row is generated set-based with generate_series. Rows are written in
-- created_at order with time-ordered ids, as the proxy writes them, so the
-- primary key is appended to; the other indexes on the two big tables are
-- dropped for the load and rebuilt afterwards.

\set ON_ERROR_STOP on
\if :{?interactions} \else \set interactions 20000000 \endif
\if :{?receipt_share} \else \set receipt_share 1.0 \endif
\if :{?tool_calls} \else \set tool_calls 5000000 \endif
\if :{?skill_events} \else \set skill_events 500000 \endif
\if :{?users} \else \set users 2000 \endif
\if :{?teams} \else \set teams 50 \endif
\if :{?agents} \else \set agents 400 \endif
\if :{?personal_agents} \else \set personal_agents 2600 \endif
\if :{?virtual_keys} \else \set virtual_keys 300 \endif
\if :{?days} \else \set days 365 \endif
-- Share of each person's calls made with their own agent, key, client,
-- sign-in method and models; the rest pick each of these at random.
\if :{?home_share} \else \set home_share 0.8 \endif

DO $$
BEGIN
  IF current_database() !~ '^costs_bench' THEN
    RAISE EXCEPTION 'Refusing to seed %: only scratch databases named costs_bench* are seeded', current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM interactions LIMIT 1) THEN
    RAISE EXCEPTION 'interactions is not empty; seed a freshly migrated scratch database';
  END IF;
END $$;

SET session_replication_role = replica;
SET synchronous_commit = off;
SET maintenance_work_mem = '1GB';
SET max_parallel_maintenance_workers = 2;
SELECT setseed(0.42);

-- Deterministic ids per entity kind (md5 is unavailable on FIPS builds).
CREATE FUNCTION pg_temp.bench_uuid(kind int, n bigint) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$
  SELECT (lpad(to_hex(kind), 8, '0') || '-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid
$$;

-- ===== dimensions =====
\echo dimensions
INSERT INTO organization (id, name, slug, created_at)
VALUES ('bench-org', 'Bench', 'bench', now());

INSERT INTO "user" (id, name, email)
SELECT 'bench-user-' || g, 'User ' || g, 'user' || g || '@bench.test'
FROM generate_series(1, :users) g;

INSERT INTO member (id, organization_id, user_id, role, created_at)
SELECT 'bench-member-' || g, 'bench-org', 'bench-user-' || g,
  CASE WHEN g = 1 THEN 'admin' ELSE 'member' END, now()
FROM generate_series(1, :users) g;

INSERT INTO team (id, name, organization_id, created_at, updated_at)
SELECT 'bench-team-' || g, 'Team ' || g, 'bench-org', now(), now()
FROM generate_series(1, :teams) g;

-- Everyone is in one team; every third person in a second one.
INSERT INTO team_member (id, team_id, user_id, created_at)
SELECT 'bench-tm-' || u || '-' || t, 'bench-team-' || t, 'bench-user-' || u, now()
FROM generate_series(1, :users) u
CROSS JOIN LATERAL (
  SELECT 1 + (u % :teams) AS t
  UNION
  SELECT 1 + ((u * 7) % :teams) WHERE u % 3 = 0
) teams;

-- Shared agents (some proxies and gateways) used by most traffic, and a long
-- tail of personal agents, as personal gateways and proxies create.
INSERT INTO agents (id, name, organization_id, agent_type, scope, author_id)
SELECT pg_temp.bench_uuid(1, g), 'Agent ' || g, 'bench-org',
  CASE WHEN g % 8 = 0 THEN 'llm_proxy' WHEN g % 8 = 1 THEN 'mcp_gateway' ELSE 'agent' END,
  'org', 'bench-user-' || (1 + g % :users)
FROM generate_series(1, :agents) g;
INSERT INTO agents (id, name, organization_id, agent_type, scope, author_id)
SELECT pg_temp.bench_uuid(2, g), 'Personal ' || g, 'bench-org',
  CASE WHEN g % 3 = 0 THEN 'llm_proxy' ELSE 'agent' END,
  'personal', 'bench-user-' || (1 + g % :users)
FROM generate_series(1, :personal_agents) g;

-- Shared agents grant read to one or two teams; personal ones to their owner.
INSERT INTO resource_permission_policies (organization_id, resource, scope, grants)
SELECT 'bench-org',
  CASE WHEN g % 8 = 1 THEN 'mcpGateway' ELSE 'agent' END,
  pg_temp.bench_uuid(1, g)::text,
  jsonb_build_array(
    jsonb_build_object('subject', jsonb_build_object('type', 'team', 'id', 'bench-team-' || (1 + g % :teams)), 'actions', jsonb_build_array('read', 'use')),
    jsonb_build_object('subject', jsonb_build_object('type', 'role', 'id', 'admin'), 'actions', jsonb_build_array('read', 'use', 'update', 'delete', 'manage-permissions'))
  ) || CASE WHEN g % 3 = 0 THEN jsonb_build_array(
    jsonb_build_object('subject', jsonb_build_object('type', 'team', 'id', 'bench-team-' || (1 + (g * 7) % :teams)), 'actions', jsonb_build_array('read'))
  ) ELSE '[]'::jsonb END
FROM generate_series(1, :agents) g;
INSERT INTO resource_permission_policies (organization_id, resource, scope, grants)
SELECT 'bench-org', 'agent', pg_temp.bench_uuid(2, g)::text,
  jsonb_build_array(jsonb_build_object(
    'subject', jsonb_build_object('type', 'user', 'id', 'bench-user-' || (1 + g % :users)),
    'actions', jsonb_build_array('read', 'use', 'update', 'delete', 'manage-permissions')))
FROM generate_series(1, :personal_agents) g;

INSERT INTO virtual_api_keys (id, name, secret_id, token_start, organization_id, billing_team_id)
SELECT pg_temp.bench_uuid(3, g), 'Key ' || g, pg_temp.bench_uuid(4, g), 'arch_' || g, 'bench-org',
  CASE WHEN g % 3 = 0 THEN 'bench-team-' || (1 + g % :teams) END
FROM generate_series(1, :virtual_keys) g;

-- 8 providers x 5 models; two provider keys per provider.
CREATE TEMP TABLE bench_models AS
SELECT m, 'bench-model-' || m AS model,
  (ARRAY['anthropic', 'openai', 'gemini', 'bedrock', 'azure', 'mistral', 'groq', 'openrouter'])[1 + m / 5] AS provider,
  (0.5 + (m % 5) * 1.5)::numeric AS p_in
FROM generate_series(0, 39) m;

INSERT INTO chat_api_keys (id, organization_id, name, provider)
SELECT pg_temp.bench_uuid(5, (p * 2 + k)), 'bench-org', 'Provider key ' || (p * 2 + k),
  (ARRAY['anthropic', 'openai', 'gemini', 'bedrock', 'azure', 'mistral', 'groq', 'openrouter'])[1 + p]
FROM generate_series(0, 7) p, generate_series(0, 1) k;

INSERT INTO apps (id, organization_id, name, latest_version, author_id, authoring_session_id)
SELECT pg_temp.bench_uuid(6, g), 'bench-org', 'App ' || g, 1, 'bench-user-' || (1 + g % :users), 'bench-app-session-' || g
FROM generate_series(1, 100) g;

INSERT INTO skills (id, organization_id, name, description, content, latest_version, author_id)
SELECT pg_temp.bench_uuid(7, g), 'bench-org', 'skill-' || g, 'Skill ' || g, '# Skill', 1, 'bench-user-' || (1 + g % :users)
FROM generate_series(1, 200) g;

-- Limits: per team, per key, and a default per-user limit.
INSERT INTO limits (entity_type, entity_id, limit_type, limit_value, cleanup_interval)
SELECT 'team', 'bench-team-' || g, 'token_cost', 1000, 'calendar_month' FROM generate_series(1, :teams) g;
INSERT INTO limits (entity_type, entity_id, limit_type, limit_value, cleanup_interval)
SELECT 'virtual_key', pg_temp.bench_uuid(3, g)::text, 'token_cost', 200, 'calendar_month' FROM generate_series(1, 100) g;
UPDATE organization SET default_user_limit_value = 50, default_user_limit_cleanup_interval = 'calendar_month' WHERE id = 'bench-org';

-- ===== interactions =====
-- Drop the secondary indexes for the load; rebuilt from these definitions.
CREATE TABLE bench_saved_indexes AS
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename IN ('interactions', 'interaction_billing', 'mcp_tool_calls')
  AND indexname NOT IN ('interactions_pkey', 'interaction_billing_pkey', 'mcp_tool_calls_pkey');
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT indexname FROM bench_saved_indexes LOOP
    EXECUTE format('DROP INDEX %I', r.indexname);
  END LOOP;
END $$;

\echo interactions
-- Traffic grows linearly over the year: the last week holds about 4% of it,
-- the last 30 days 16% and the last 90 days 43%. Usage is skewed towards a
-- few heavy users, and each person mostly sticks to their own agent, key,
-- client, sign-in method and three models (80% of their calls), so the
-- dimensions are correlated the way real usage is.
INSERT INTO interactions (
  id, created_at, profile_id, app_id, user_id, type, model, request, response,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  cache_write_1h_tokens, input_tokens_estimated, cost, baseline_cost,
  cache_savings, billing_mode, auth_method, virtual_key_id,
  passthrough_virtual_key_id, authenticated_app_id, authenticated_app_name,
  provider_api_key_id, source, session_id, external_agent_id, billing_team_id,
  attribution_labels
)
SELECT
  uuidv7(t.created_at - clock_timestamp()), t.created_at,
  CASE WHEN r.owner < 0.90 THEN pg_temp.bench_uuid(1, CASE WHEN p.home THEN 1 + (p.uid * 37) % :agents ELSE 1 + floor(:agents * r.a ^ 2)::int END)
       WHEN r.owner < 0.97 THEN pg_temp.bench_uuid(2, 1 + (p.uid * 7) % :personal_agents) END,
  CASE WHEN r.owner >= 0.97 THEN pg_temp.bench_uuid(6, (1 + floor(100 * r.a)::int)) END,
  CASE WHEN p.uid > 0 THEN 'bench-user-' || p.uid END,
  bm.provider || ':messages', bm.model, jsonb_build_object('pad', repeat('x', 1000)), '{}'::jsonb,
  tok.input, tok.output, tok.cache_read, tok.cache_write, 0, r.est < 0.02,
  c.cost, c.cost, c.savings,
  CASE WHEN am.method = 'passthrough_virtual_key' AND p.uid % 10 < 8 THEN 'subscription' ELSE 'metered' END,
  am.method,
  CASE WHEN am.method = 'virtual_key' THEN pg_temp.bench_uuid(3, vk.k) END,
  CASE WHEN am.method = 'passthrough_virtual_key' THEN pg_temp.bench_uuid(3, vk.k) END,
  CASE WHEN am.method = 'oauth_client_credentials' THEN 'bench-client-' || (1 + vk.k % 20) END,
  CASE WHEN am.method = 'oauth_client_credentials' THEN 'Client ' || (1 + vk.k % 20) END,
  CASE WHEN am.method IN ('provider_key', 'internal') THEN pg_temp.bench_uuid(5, ((bm.m / 5) * 2 + p.uid % 2)) END,
  (ARRAY['api', 'api', 'api', 'api', 'chat', 'model_router', 'chatops:slack', 'schedule-trigger', 'guardrail:annotator', 'chat'])[1 + floor(10 * r.src)::int],
  'bench-session-' || (g / 25),
  CASE WHEN p.client < 4 THEN (ARRAY['claude-code', 'codex', 'cursor', 'opencode'])[1 + p.client] END,
  CASE WHEN am.method IN ('virtual_key', 'passthrough_virtual_key') AND vk.k % 3 = 0 THEN 'bench-team-' || (1 + vk.k % :teams) END,
  CASE WHEN am.method IN ('virtual_key', 'passthrough_virtual_key') AND vk.k % 5 = 0
    THEN jsonb_build_object('env', CASE WHEN vk.k % 10 = 0 THEN 'prod' ELSE 'staging' END, 'cost_center', 'cc-' || vk.k % 50) END
FROM generate_series(1, :interactions) g
CROSS JOIN LATERAL (
  SELECT now() - make_interval(secs => :days * 86400.0 * (1 - sqrt(g::float8 / :interactions))) AS created_at
) t
-- Each draw mentions g so that it is evaluated per row, not once.
CROSS JOIN LATERAL (
  SELECT random() + 0 * g owner, random() + 0 * g a, random() + 0 * g u,
    random() + 0 * g mdl, random() + 0 * g est, random() + 0 * g auth,
    random() + 0 * g home, random() + 0 * g k, random() + 0 * g src,
    random() + 0 * g client, random() + 0 * g t1, random() + 0 * g t2,
    random() + 0 * g t3, random() + 0 * g t4
) r
CROSS JOIN LATERAL (
  SELECT CASE WHEN r.u < 0.95 THEN 1 + floor(:users * (r.u / 0.95) ^ 1.5)::int ELSE 0 END AS uid,
    r.home < :home_share AS home
) p0
CROSS JOIN LATERAL (
  SELECT p0.*,
    CASE WHEN p0.home THEN p0.uid % 8 ELSE floor(8 * r.client)::int END AS client
) p
CROSS JOIN LATERAL (
  SELECT CASE WHEN p.home THEN (p.uid * 11 + floor(3 * r.mdl)::int * 5) % 40 ELSE floor(40 * r.mdl ^ 2)::int END AS m
) mi
CROSS JOIN LATERAL (
  SELECT mi.m, 'bench-model-' || mi.m AS model,
    (ARRAY['anthropic', 'openai', 'gemini', 'bedrock', 'azure', 'mistral', 'groq', 'openrouter'])[1 + mi.m / 5] AS provider,
    (0.5 + (mi.m % 5) * 1.5)::numeric AS p_in
) bm
CROSS JOIN LATERAL (
  SELECT CASE WHEN p.home THEN 1 + (p.uid * 13) % :virtual_keys ELSE 1 + floor(:virtual_keys * r.k ^ 2)::int END AS k
) vk
CROSS JOIN LATERAL (
  SELECT x AS method FROM (SELECT CASE WHEN p.home THEN ((p.uid * 3) % 100) / 100.0 ELSE r.auth END AS x0) a
  CROSS JOIN LATERAL (
    SELECT CASE WHEN x0 < 0.35 THEN 'passthrough_virtual_key'
                WHEN x0 < 0.70 THEN 'virtual_key'
                WHEN x0 < 0.82 THEN 'internal'
                WHEN x0 < 0.87 THEN 'oauth_client_credentials'
                WHEN x0 < 0.92 THEN 'provider_key' END AS x
  ) m
) am
CROSS JOIN LATERAL (
  SELECT (500 + floor(20000 * r.t1))::int AS input,
    (50 + floor(2000 * r.t2))::int AS output,
    CASE WHEN r.t3 < 0.6 THEN floor(50000 * r.t3)::int ELSE 0 END AS cache_read,
    CASE WHEN r.t4 < 0.2 THEN floor(25000 * r.t4)::int ELSE 0 END AS cache_write
) tok
CROSS JOIN LATERAL (
  SELECT round((tok.input * bm.p_in + tok.output * bm.p_in * 5 + tok.cache_read * bm.p_in * 0.1 + tok.cache_write * bm.p_in * 1.25) / 1000000, 10) AS cost,
    round((tok.cache_read * bm.p_in * 0.9 - tok.cache_write * bm.p_in * 0.25) / 1000000, 10) AS savings
) c;

\echo receipts
-- One receipt per request (the steady state once every request is settled);
-- one in twenty also billed an advisor on another model.
INSERT INTO interaction_billing (interaction_id, fingerprint, usage, organization_id, user_id, billing_mode, billing_team_id, created_at, attribution_labels)
SELECT i.id, replace(i.id::text, '-', ''),
  jsonb_build_object(
    'cost', i.cost::text, 'mode', 'enforce', 'issues', '[]'::jsonb, 'status', 'complete', 'version', 1,
    'components', jsonb_build_array(jsonb_build_object(
      'id', 'primary', 'kind', 'message', 'model', i.model, 'provider', bm.provider,
      'cost', round(i.cost * CASE WHEN adv THEN 0.8 ELSE 1 END, 10)::text,
      'prices', jsonb_build_object('input', bm.p_in::text, 'output', (bm.p_in * 5)::text, 'cacheRead', (bm.p_in * 0.1)::text, 'cacheWrite', (bm.p_in * 1.25)::text, 'cacheWrite1h', (bm.p_in * 2)::text, 'source', 'models_dev'),
      'inputTokens', i.input_tokens, 'outputTokens', i.output_tokens,
      'cacheReadTokens', i.cache_read_tokens, 'cacheWriteTokens', i.cache_write_tokens, 'cacheWrite1hTokens', 0
    )) || CASE WHEN adv THEN jsonb_build_array(jsonb_build_object(
      'id', 'advisor', 'kind', 'advisor_message', 'model', adv_model.model, 'provider', adv_model.provider,
      'cost', round(i.cost * 0.2, 10)::text,
      'prices', jsonb_build_object('input', adv_model.p_in::text, 'output', (adv_model.p_in * 5)::text, 'cacheRead', (adv_model.p_in * 0.1)::text, 'source', 'models_dev'),
      'inputTokens', i.input_tokens / 5, 'outputTokens', i.output_tokens / 5,
      'cacheReadTokens', 0, 'cacheWriteTokens', 0, 'cacheWrite1hTokens', 0
    )) ELSE '[]'::jsonb END
  ),
  'bench-org', i.user_id, i.billing_mode, i.billing_team_id, i.created_at, i.attribution_labels
FROM interactions i
JOIN bench_models bm ON bm.model = i.model
CROSS JOIN LATERAL (SELECT hashtext(i.id::text) % 20 = 0 AS adv) a
JOIN bench_models adv_model ON adv_model.m = (bm.m + 7) % 40
WHERE random() < :receipt_share;

\echo tool calls
INSERT INTO mcp_tool_calls (agent_id, app_id, owner_type, mcp_server_name, tool_name, method, user_id, created_at, duration_ms, is_error, session_id)
SELECT
  CASE WHEN r.o < 0.95 THEN pg_temp.bench_uuid(1, (1 + floor(:agents * r.a ^ 2)::int)) END,
  CASE WHEN r.o >= 0.95 THEN pg_temp.bench_uuid(6, (1 + floor(100 * r.a)::int)) END,
  CASE WHEN r.o >= 0.95 THEN 'app' ELSE 'agent' END,
  'server-' || floor(30 * r.s ^ 2)::int, 'tool-' || floor(10 * r.t)::int, 'tools/call',
  CASE WHEN r.u < 0.95 THEN 'bench-user-' || (1 + floor(:users * r.u)::int) END,
  now() - make_interval(secs => :days * 86400.0 * (1 - sqrt(g::float8 / :tool_calls))),
  floor(2000 * r.t)::int, r.t < 0.03, 'bench-session-' || (g / 10)
FROM generate_series(1, :tool_calls) g
CROSS JOIN LATERAL (
  SELECT random() + 0 * g o, random() + 0 * g a, random() + 0 * g s,
    random() + 0 * g t, random() + 0 * g u
) r;

\echo skill events
INSERT INTO skill_usage_events (skill_id, user_id, created_at, session_id, context_tokens)
SELECT pg_temp.bench_uuid(7, (1 + floor(200 * random() ^ 2)::int)),
  'bench-user-' || (1 + floor(:users * random())::int),
  now() - make_interval(secs => :days * 86400.0 * (1 - sqrt(g::float8 / :skill_events))),
  'bench-session-' || (g * 7), (500 + floor(5000 * random()))::int
FROM generate_series(1, :skill_events) g;

-- ===== rebuild =====
\echo indexes
SET session_replication_role = origin;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT indexname, indexdef FROM bench_saved_indexes LOOP
    RAISE NOTICE 'building %', r.indexname;
    EXECUTE r.indexdef;
  END LOOP;
END $$;
DROP TABLE bench_saved_indexes;

\echo analyze
VACUUM (ANALYZE) interactions;
VACUUM (ANALYZE) interaction_billing;
VACUUM (ANALYZE) mcp_tool_calls;
ANALYZE;
