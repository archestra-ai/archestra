-- One LLM Proxy per organization.
--
-- Elects the surviving `llm_proxy` row for each organization, absorbs
-- settings and cost limits from the organization's other proxy-capable rows
-- (`llm_proxy` rows and legacy dual-purpose `profile` rows), and shrinks
-- stored role grants to the remaining `llmProxy` actions. Historic rows are
-- intentionally left in place — interactions, statistics, and log-access
-- queries keep resolving them — while runtime resolution collapses their ids
-- onto the elected row, so they receive no new traffic.
--
-- Must run BEFORE the migration that creates the partial unique index
-- `agents_org_default_llm_proxy_idx` (one default llm_proxy per org): this is
-- the migration that establishes that invariant on live data.
--
-- The whole migration is one guarded DO block: `organization` is a
-- better-auth-managed table that drizzle migrations run before on a fresh
-- install, so when it does not exist yet there is nothing to migrate (no
-- organizations means no proxy rows either) and the block returns early.
-- Startup seeding (`AgentModel.ensureLlmProxiesForAllOrganizations`) creates
-- the LLM Proxy for organizations born after this migration.
DO $$
DECLARE
  warn_rec RECORD;
  role_rec RECORD;
  perm jsonb;
  actions jsonb;
  has_write boolean;
  has_read boolean;
  new_actions jsonb;
BEGIN
  IF to_regclass('organization') IS NULL THEN
    RETURN;
  END IF;

  -- Election: per organization prefer the validated connection-default
  -- llm_proxy row, then the is_default row, then the oldest non-personal row.
  CREATE TEMPORARY TABLE "_llm_proxy_election" AS
  WITH "candidates" AS (
    SELECT
      a."id",
      a."organization_id",
      CASE
        WHEN a."id" = o."connection_default_llm_proxy_id" THEN 0
        WHEN a."is_default" THEN 1
        WHEN NOT a."is_personal_proxy" THEN 2
        ELSE 3
      END AS "rank",
      a."created_at"
    FROM "agents" a
    JOIN "organization" o ON o."id" = a."organization_id"
    WHERE a."agent_type" = 'llm_proxy' AND a."deleted_at" IS NULL
  )
  SELECT DISTINCT ON ("organization_id") "organization_id", "id"
  FROM "candidates"
  ORDER BY "organization_id", "rank", "created_at";

  -- Organizations with no llm_proxy rows get a fresh one.
  INSERT INTO "agents" ("organization_id", "name", "agent_type", "is_default", "scope")
  SELECT o."id", 'LLM Proxy', 'llm_proxy', true, 'org'
  FROM "organization" o
  WHERE NOT EXISTS (
    SELECT 1 FROM "_llm_proxy_election" e WHERE e."organization_id" = o."id"
  );

  INSERT INTO "_llm_proxy_election" ("organization_id", "id")
  SELECT a."organization_id", a."id"
  FROM "agents" a
  WHERE a."agent_type" = 'llm_proxy'
    AND a."deleted_at" IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "_llm_proxy_election" e
      WHERE e."organization_id" = a."organization_id"
    );

  -- Demote every non-elected llm_proxy row so the upcoming partial unique
  -- index (one default llm_proxy per organization) cannot fail.
  UPDATE "agents" a
  SET "is_default" = false
  FROM "_llm_proxy_election" e
  WHERE a."organization_id" = e."organization_id"
    AND a."agent_type" = 'llm_proxy'
    AND a."id" <> e."id"
    AND a."is_default" = true;

  -- Normalize the elected row. `consider_context_untrusted` ORs across the
  -- organization's other proxy-capable rows (the secure direction).
  UPDATE "agents" a
  SET
    "name" = 'LLM Proxy',
    "description" = NULL,
    "is_default" = true,
    "scope" = 'org',
    "environment_id" = NULL,
    "is_personal_proxy" = false,
    "author_id" = NULL,
    "consider_context_untrusted" = a."consider_context_untrusted" OR EXISTS (
      SELECT 1 FROM "agents" d
      WHERE d."organization_id" = a."organization_id"
        AND d."id" <> a."id"
        AND d."deleted_at" IS NULL
        AND d."agent_type" IN ('llm_proxy', 'profile')
        AND d."consider_context_untrusted" = true
    )
  FROM "_llm_proxy_election" e
  WHERE a."id" = e."id";

  -- Identity provider: keep the elected row's; when it has none and exactly
  -- one distinct provider exists across the organization's other
  -- proxy-capable rows, adopt it so live JWT (JWKS) setups keep working
  -- through the collapse. Donor rows keep their own value (legacy `profile`
  -- rows still use it on the MCP gateway side).
  UPDATE "agents" a
  SET "identity_provider_id" = donor."idp"
  FROM "_llm_proxy_election" e,
  LATERAL (
    SELECT min(d."identity_provider_id") AS "idp"
    FROM "agents" d
    WHERE d."organization_id" = e."organization_id"
      AND d."id" <> e."id"
      AND d."deleted_at" IS NULL
      AND d."agent_type" IN ('llm_proxy', 'profile')
      AND d."identity_provider_id" IS NOT NULL
    HAVING count(DISTINCT d."identity_provider_id") = 1
  ) donor
  WHERE a."id" = e."id"
    AND a."identity_provider_id" IS NULL
    AND donor."idp" IS NOT NULL;

  -- An organization with several distinct identity providers spread across
  -- its proxy rows cannot be collapsed losslessly: only the LLM Proxy's own
  -- provider (or the single unambiguous donor adopted above) remains active
  -- for proxy JWT authentication.
  FOR warn_rec IN
    SELECT e."organization_id",
           count(DISTINCT d."identity_provider_id") AS "provider_count"
    FROM "_llm_proxy_election" e
    JOIN "agents" d ON d."organization_id" = e."organization_id"
      AND d."id" <> e."id"
      AND d."deleted_at" IS NULL
      AND d."agent_type" IN ('llm_proxy', 'profile')
      AND d."identity_provider_id" IS NOT NULL
    GROUP BY e."organization_id"
    HAVING count(DISTINCT d."identity_provider_id") > 1
  LOOP
    RAISE WARNING 'Organization % has % distinct identity providers configured across its LLM proxy rows; only the LLM Proxy''s own provider remains active for proxy JWT authentication. Reconfigure it on the LLM Proxy page if needed.',
      warn_rec."organization_id", warn_rec."provider_count";
  END LOOP;

  -- An org-scoped singleton carries no team gating, labels, or user grants;
  -- stale team rows would silently apply team limits to all proxy traffic.
  DELETE FROM "agent_team" j
  USING "_llm_proxy_election" e
  WHERE j."agent_id" = e."id";

  DELETE FROM "agent_labels" j
  USING "_llm_proxy_election" e
  WHERE j."agent_id" = e."id";

  DELETE FROM "agent_user" j
  USING "_llm_proxy_election" e
  WHERE j."agent_id" = e."id";

  -- Re-key cost limits from the organization's other proxy-capable rows to
  -- the LLM Proxy, preserving row ids and accumulated usage. No dedupe: the
  -- runtime evaluates every limit on an entity, so the most restrictive wins.
  UPDATE "limits" l
  SET "entity_id" = e."id"::text
  FROM "agents" d
  JOIN "_llm_proxy_election" e ON e."organization_id" = d."organization_id"
  WHERE l."entity_type" = 'agent'
    AND l."entity_id" = d."id"::text
    AND d."id" <> e."id"
    AND d."agent_type" IN ('llm_proxy', 'profile');

  -- The `llmProxy` resource keeps only `read` and `update`. Roles that
  -- granted any of the removed write/admin actions keep control of the
  -- LLM Proxy through `read` + `update` instead of silently losing access
  -- when stored actions are sanitized against the current action list.
  FOR role_rec IN SELECT "id", "permission" FROM "organization_role" LOOP
    BEGIN
      perm := role_rec."permission"::jsonb;
    EXCEPTION WHEN others THEN
      CONTINUE;
    END;
    IF perm IS NULL OR jsonb_typeof(perm) <> 'object' OR NOT perm ? 'llmProxy' THEN
      CONTINUE;
    END IF;
    actions := perm -> 'llmProxy';
    IF jsonb_typeof(actions) <> 'array' THEN
      CONTINUE;
    END IF;
    has_write := actions ?| ARRAY['create', 'update', 'delete', 'admin', 'team-admin', 'deploy-to-restricted'];
    has_read := actions ? 'read';
    IF has_write THEN
      new_actions := '["read", "update"]'::jsonb;
    ELSIF has_read THEN
      new_actions := '["read"]'::jsonb;
    ELSE
      new_actions := '[]'::jsonb;
    END IF;
    IF new_actions IS DISTINCT FROM actions THEN
      UPDATE "organization_role"
      SET "permission" = jsonb_set(perm, '{llmProxy}', new_actions)::text
      WHERE "id" = role_rec."id";
    END IF;
  END LOOP;

  -- "_llm_proxy_election" is TEMPORARY and vanishes with the migration
  -- connection; no explicit DROP needed.
END $$;
