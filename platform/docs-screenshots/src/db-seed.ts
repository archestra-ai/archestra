import { execSync } from "node:child_process";
import {
  AGENT_PLACEMENT,
  CHANNEL_BINDINGS,
  COLLEAGUES,
  KNOWLEDGE_BASE_AGENTS,
  KNOWLEDGE_BASES,
  KNOWLEDGE_CONNECTORS,
  KNOWLEDGE_DIRECTORIES,
  KNOWLEDGE_FILES,
  USAGE,
} from "./dataset";
import type { SeedState } from "./seed";

/**
 * Seeds the few records the public API cannot create, such as messaging channels,
 * which normally appear only when a live Slack, Teams, or Telegram bot discovers
 * them. Runs SQL against the instance's own database, so it works only where
 * that database is reachable: local Tilt, or the e2e-lite stack. Additive and
 * idempotent, like the API seed.
 */
export async function seedDatabaseRows(state: SeedState): Promise<void> {
  const organizationId = state.organization.id;
  const agentId = state.agents[CHANNEL_BINDINGS.agent];
  const values = CHANNEL_BINDINGS.channels
    .map((channel) =>
      [
        sql(channel.id),
        sql(organizationId),
        sql(channel.provider),
        sql(channel.channelId),
        sql(channel.workspaceId),
        sql(channel.channelName),
        sql(channel.workspaceName),
        String(channel.answerAllMessages),
        sql(channel.channelInstructions),
        sql(agentId),
      ].join(", "),
    )
    .map((row) => `(${row})`)
    .join(",\n  ");

  runSql(`INSERT INTO chatops_channel_binding
  (id, organization_id, provider, channel_id, workspace_id, channel_name, workspace_name, answer_all_messages, channel_instructions, agent_id)
VALUES
  ${values}
ON CONFLICT DO NOTHING;`);

  placeAgents(state);
  seedColleagues(state);
  seedUsage(state);
  seedLimitUsage();
  seedKnowledge(state);
}

/**
 * Spreads the upload times of the seeded Knowledge Files over the last weeks,
 * so the Files page does not show every file as added just now.
 */
export function backdateKnowledgeFiles(state: SeedState): void {
  runSql(
    [
      `UPDATE kb_directories SET created_at = now() - interval '45 days' WHERE organization_id = ${sql(state.organization.id)} AND name IN (${KNOWLEDGE_DIRECTORIES.map(sql).join(", ")});`,
      ...KNOWLEDGE_FILES.map(
      (file, index) =>
        `UPDATE kb_files SET created_at = now() - make_interval(hours => ${3 + index * 29}) WHERE organization_id = ${sql(state.organization.id)} AND filename = ${sql(file.filename)};`,
      ),
    ].join("\n"),
  );
}

/**
 * Members the persona works with. Better Auth owns sign-up, so these accounts
 * have no password and exist only to give usage a spread of people.
 */
function seedColleagues(state: SeedState): void {
  const organizationId = state.organization.id;
  runSql(
    COLLEAGUES.map((colleague) => {
      const userId = `docs-user-${colleague.key}`;
      state.users[colleague.key] = userId;
      return `INSERT INTO "user" (id, name, email, email_verified) VALUES (${sql(userId)}, ${sql(colleague.name)}, ${sql(colleague.email)}, true) ON CONFLICT DO NOTHING;
INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (${sql(`docs-member-${colleague.key}`)}, ${sql(organizationId)}, ${sql(userId)}, 'member', now()) ON CONFLICT DO NOTHING;`;
    }).join("\n"),
  );
}

/**
 * Thirty days of model requests, so Costs & Limits and My Usage have numbers
 * to show. Each stream belongs to one person and one agent or coding client.
 * The rows are tagged with a session prefix, and a rerun replaces them.
 */
function seedUsage(state: SeedState): void {
  const streams = USAGE.map((stream, index) =>
    [
      String(index),
      sql(state.users[stream.user]),
      // Coding clients reach the model through the LLM Proxy, so their rows carry its id.
      stream.agent
        ? sql(state.agents[stream.agent])
        : `(SELECT id::text FROM agents WHERE agent_type = 'llm_proxy' AND organization_id = ${sql(state.organization.id)} LIMIT 1)`,
      stream.client ? sql(stream.client) : stream.agent ? sql(state.agents[stream.agent]) : "NULL",
      sql(stream.type),
      sql(stream.model),
      sql(stream.billingMode),
      sql(stream.authMethod),
      sql(stream.source),
      String(stream.perDay),
      String(stream.inputTokens),
      String(stream.outputTokens),
      String(stream.inputPrice),
      String(stream.outputPrice),
      String(stream.cacheShare),
    ].join(", "),
  )
    .map((row) => `(${row})`)
    .join(",\n    ");

  runSql(`DELETE FROM interactions WHERE session_id LIKE '${USAGE_SESSION_PREFIX}%';
SELECT setseed(0.42);
INSERT INTO interactions
  (profile_id, user_id, external_agent_id, type, model, billing_mode, auth_method, source, session_id,
   request, response, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, cache_savings, created_at)
SELECT
  s.agent_id::uuid, s.user_id, s.client, s.type, s.model, s.billing_mode, s.auth_method, s.source,
  '${USAGE_SESSION_PREFIX}' || s.stream || '-' || d || '-' || (n / 12),
  jsonb_build_object('model', s.model, 'messages', '[]'::jsonb), '{}'::jsonb,
  t.input_tokens, t.output_tokens, (t.input_tokens * s.cache_share)::int,
  CASE WHEN s.type = 'anthropic:messages' THEN (t.input_tokens * 0.06)::int END,
  t.input_tokens * (1 - 0.9 * s.cache_share) * s.input_price / 1e6 + t.output_tokens * s.output_price / 1e6,
  t.input_tokens * s.cache_share * 0.9 * s.input_price / 1e6,
  now() - make_interval(days => d, mins => (random() * 1400)::int)
FROM (VALUES
    ${streams}
  ) AS s(stream, user_id, agent_id, client, type, model, billing_mode, auth_method, source, per_day, input_tokens, output_tokens, input_price, output_price, cache_share)
CROSS JOIN generate_series(0, 29) AS d
CROSS JOIN LATERAL generate_series(1, greatest(1, (s.per_day * (0.6 + random() * 0.8) * (CASE WHEN extract(isodow FROM now() - make_interval(days => d)) > 5 THEN 0.35 ELSE 1 END))::int)) AS n
CROSS JOIN LATERAL (SELECT
  (s.input_tokens * (0.4 + random() * 1.2))::int AS input_tokens,
  (s.output_tokens * (0.4 + random() * 1.2))::int AS output_tokens) AS t;
UPDATE interactions SET baseline_model = model, baseline_cost = cost WHERE session_id LIKE '${USAGE_SESSION_PREFIX}%';`);
}

/**
 * The embedding model, connectors, and indexed documents behind the Knowledge
 * pages. The connectors point at fictional hosts, so their rows carry a
 * finished sync and documents instead of a sync that would fail. A rerun
 * replaces the documents.
 */
function seedKnowledge(state: SeedState): void {
  const organizationId = sql(state.organization.id);
  const persona = sql(state.users.persona);
  // Knowledge pages show a placeholder until an embedding model is set. Set
  // one only where none is, so an instance's own choice is never replaced.
  const embedding = `UPDATE organization SET
  embedding_chat_api_key_id = (SELECT id FROM chat_api_keys WHERE organization_id = ${organizationId} ORDER BY (provider = 'openai') DESC, created_at LIMIT 1),
  embedding_model = 'text-embedding-3-small'
WHERE id = ${organizationId} AND embedding_chat_api_key_id IS NULL;`;
  const descriptions = KNOWLEDGE_BASES.map(
    (base) =>
      `UPDATE knowledge_bases SET description = ${sql(base.description)} WHERE id = ${sql(state.knowledgeBases[base.name])};`,
  );
  const connectors = KNOWLEDGE_CONNECTORS.map((connector) => {
    const id = sql(connector.id);
    const syncedAt = `now() - make_interval(mins => ${connector.syncedMinutesAgo})`;
    return `INSERT INTO knowledge_base_connectors
  (id, organization_id, name, description, connector_type, config, schedule, enabled, last_sync_at, last_sync_status, created_by, created_at)
VALUES (${id}, ${organizationId}, ${sql(connector.name)}, ${sql(connector.description)}, ${sql(connector.config.type)}, ${sql(JSON.stringify(connector.config))}::jsonb,
  ${sql(connector.schedule)}, true, ${syncedAt}, ${sql(connector.status)}, ${persona}, now() - interval '60 days')
ON CONFLICT (id) DO UPDATE SET last_sync_at = EXCLUDED.last_sync_at, last_sync_status = EXCLUDED.last_sync_status, deleted_at = NULL;
DELETE FROM tasks WHERE task_type = 'connector_sync' AND payload->>'connectorId' = ${id} AND status = 'pending';
${connector.knowledgeBases
  .map(
    (base) =>
      // The table has no unique key, so ON CONFLICT cannot keep a rerun from duplicating the row.
      `INSERT INTO knowledge_base_connector_assignment (knowledge_base_id, connector_id) SELECT ${sql(state.knowledgeBases[base])}, ${id} WHERE NOT EXISTS (SELECT 1 FROM knowledge_base_connector_assignment WHERE knowledge_base_id = ${sql(state.knowledgeBases[base])} AND connector_id = ${id});`,
  )
  .join("\n")}
DELETE FROM kb_documents WHERE connector_id = ${id};
INSERT INTO kb_documents (organization_id, connector_id, source_id, title, content, content_hash, embedding_status, chunk_count, created_at, updated_at)
SELECT ${organizationId}, ${id}, 'docs-' || n, ${sql(connector.name)} || ' document ' || n, 'Seeded document', encode(sha256(convert_to(${id} || n, 'UTF8')), 'hex'), 'completed', 4,
  now() - make_interval(days => n % 300), ${syncedAt}
FROM generate_series(1, ${connector.documents}) AS n;`;
  });
  const agents = KNOWLEDGE_BASE_AGENTS.map(
    (link) =>
      `INSERT INTO agent_knowledge_base (agent_id, knowledge_base_id) VALUES (${sql(state.agents[link.agent])}, ${sql(state.knowledgeBases[link.knowledgeBase])}) ON CONFLICT DO NOTHING;`,
  );
  runSql([embedding, ...descriptions, ...connectors, ...agents].join("\n"));
}

function placeAgents(state: SeedState): void {
  const statements = AGENT_PLACEMENT.map((placement) => {
    const agentId = sql(state.agents[placement.agent]);
    return `INSERT INTO agent_team (agent_id, team_id) VALUES (${agentId}, ${sql(state.teams[placement.team])}) ON CONFLICT DO NOTHING;
UPDATE agents SET environment_id = ${sql(state.environments[placement.environment])} WHERE id = ${agentId};`;
  });
  runSql(statements.join("\n"));
}

/**
 * Month-to-date token use for every token-cost limit, from the seeded requests.
 * The proxy keeps these totals as requests arrive; seeded rows skip the proxy.
 */
function seedLimitUsage(): void {
  runSql(`DELETE FROM limit_model_usage WHERE limit_id IN (SELECT id FROM limits WHERE limit_type = 'token_cost');
INSERT INTO limit_model_usage (limit_id, model, current_usage_tokens_in, current_usage_tokens_out)
SELECT l.id, i.model, sum(i.input_tokens), sum(i.output_tokens)
FROM limits l
JOIN interactions i ON i.session_id LIKE '${USAGE_SESSION_PREFIX}%'
  AND i.billing_mode = 'metered'
  AND i.created_at >= date_trunc('month', now())
LEFT JOIN agents a ON a.id = i.profile_id
WHERE l.limit_type = 'token_cost' AND (
  l.entity_type = 'organization'
  OR (l.entity_type = 'team' AND EXISTS (SELECT 1 FROM agent_team t WHERE t.agent_id = a.id AND t.team_id::text = l.entity_id))
  OR (l.entity_type = 'environment' AND a.environment_id::text = l.entity_id))
GROUP BY l.id, i.model;`);
}

const USAGE_SESSION_PREFIX = "docs-usage-";

// ===

/**
 * The psql command for the target instance. Override it with
 * DOCS_SCREENSHOTS_PSQL; otherwise the e2e-lite container is used when it runs,
 * and local Tilt's PostgreSQL pod when it does not.
 */
function psqlCommand(): string {
  if (process.env.DOCS_SCREENSHOTS_PSQL) return process.env.DOCS_SCREENSHOTS_PSQL;
  const liteRunning = (() => {
    try {
      return (
        execSync("docker ps --filter name=^archestra-lite$ --format '{{.Names}}'", {
          stdio: ["ignore", "pipe", "ignore"],
        })
          .toString()
          .trim() === "archestra-lite"
      );
    } catch {
      return false;
    }
  })();
  return liteRunning
    ? "docker exec -i -u postgres archestra-lite psql -v ON_ERROR_STOP=1 -q -d archestra_dev"
    : "kubectl exec -i -n archestra-dev postgresql-0 -- env PGPASSWORD=archestra_dev_password psql -v ON_ERROR_STOP=1 -q -U archestra -d archestra_dev";
}

function runSql(statement: string): void {
  execSync(psqlCommand(), { input: statement, stdio: ["pipe", "inherit", "inherit"] });
}

function sql(value: string | null): string {
  return value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
}
