import type { SupportedProvider } from "@archestra/shared";
import { and, eq, getTableColumns, or, sql } from "drizzle-orm";
import type { SelectedFields } from "drizzle-orm/pg-core";
import { type getDb, schema } from "@/database";
import { JsonRowCodec } from "@/database/json-row";
import { PreparedQuery } from "@/database/prepared-query";
import { qualified } from "@/database/utils/qualified-column";
import type { LabelWithDetails } from "@/types/label";
import type { Team } from "@/types/team";
import { scopedCleanupDueCondition } from "./limit";
import {
  limitEntitiesCondition,
  limitEntityParameters,
} from "./limit-entity-scope";
import { throughputRuleCondition } from "./llm-throughput";

type TraceTeam = Pick<Team, "id" | "name"> & { labels: LabelWithDetails[] };

type RuntimeCandidate = {
  virtualKeyId: string;
  run: Pick<
    typeof schema.agentRunsTable.$inferSelect,
    | "organizationId"
    | "agentId"
    | "actorKind"
    | "actorId"
    | "actorUserId"
    | "taskId"
    | "workloadName"
  >;
  workspace: Pick<
    typeof schema.agentWorkspacesTable.$inferSelect,
    | "id"
    | "organizationId"
    | "agentId"
    | "actorKind"
    | "actorId"
    | "workloadName"
    | "state"
  > | null;
};

export type RuntimeIdentitySnapshot = {
  organizationId: string;
  virtualKeyIds: string[];
  candidates: RuntimeCandidate[];
};

/**
 * Fresh proxy metadata and pre-request budget state in one round trip. Nothing
 * survives the request; cleanup rereads usage and quota admission stays fresh.
 */
export default class ProxyRequestContextModel {
  static async read(params: {
    organizationId: string;
    provider: SupportedProvider;
    modelId: string;
    userId?: string;
    billingTeamId?: string;
    virtualKeyId?: string;
    oauthClientId?: string;
  }) {
    const [context] = await ProxyRequestContextModel.query.get().execute({
      ...params,
      userId: params.userId ?? null,
      billingTeamId: params.billingTeamId ?? null,
      virtualKeyId: params.virtualKeyId ?? null,
      oauthClientId: params.oauthClientId ?? null,
    });
    if (!context) throw new Error("Proxy metadata snapshot returned no row");
    return context;
  }

  static async readForProxy(
    params: Parameters<typeof ProxyRequestContextModel.read>[0] & {
      agentId: string;
      environmentId: string | null;
      limitVirtualKeyId?: string;
      passthroughVirtualKeyId?: string;
      llmOauthClientId?: string;
      includeRuntime?: boolean;
      /**
       * Authenticated caller whose team memberships attribute the call to the
       * agent's teams for team limits. Null when no credential proves a user.
       */
      teamMemberUserId?: string | null;
    },
  ) {
    const runtimeVirtualKeyIds = [
      ...new Set(
        [params.limitVirtualKeyId, params.passthroughVirtualKeyId].filter(
          (id): id is string => !!id,
        ),
      ),
    ];
    const [row] = await ProxyRequestContextModel.proxyQuery.get().execute({
      ...params,
      userId: params.userId ?? null,
      billingTeamId: params.billingTeamId ?? null,
      virtualKeyId: params.virtualKeyId ?? null,
      oauthClientId: params.oauthClientId ?? null,
      includeRuntime: params.includeRuntime === true,
      teamMemberUserId: params.teamMemberUserId ?? null,
      runtimeKey1: runtimeVirtualKeyIds[0] ?? null,
      runtimeKey2: runtimeVirtualKeyIds[1] ?? null,
      ...limitEntityParameters({
        agent: params.agentId,
        organization: params.organizationId,
        environment: params.environmentId ?? undefined,
        user: params.billingTeamId ? undefined : params.userId,
        virtual_key: [
          params.limitVirtualKeyId,
          params.passthroughVirtualKeyId,
        ].filter((id): id is string => !!id),
        llm_oauth_client: params.llmOauthClientId,
      }),
    });
    if (!row) throw new Error("Proxy request snapshot returned no row");
    const {
      limitRows,
      throughputRows,
      defaultUserLimitRow,
      runtimeCandidates,
      ...context
    } = row;
    return {
      ...context,
      runtimeSnapshot: params.includeRuntime
        ? ({
            organizationId: params.organizationId,
            virtualKeyIds: runtimeVirtualKeyIds,
            candidates: runtimeCandidates,
          } satisfies RuntimeIdentitySnapshot)
        : undefined,
      scope: {
        agentId: params.agentId,
        organizationId: params.organizationId,
        environmentId: params.environmentId,
        userId: params.userId,
        billingTeamId: params.billingTeamId,
        virtualKeyId: params.limitVirtualKeyId,
        passthroughVirtualKeyId: params.passthroughVirtualKeyId,
        llmOauthClientId: params.llmOauthClientId,
        teamMemberUserId: params.teamMemberUserId ?? null,
      },
      limitState: {
        limits: limitRows.map((raw) => {
          if (typeof raw.cleanupDue !== "boolean")
            throw new Error("Missing budget cleanup state");
          return { ...limitRowCodec.decode(raw), cleanupDue: raw.cleanupDue };
        }),
        defaultUserLimit: defaultUserLimitRow
          ? defaultRowCodec.decode(defaultUserLimitRow)
          : null,
      },
      // The same billing entities' throughput rules, so admission need not
      // look them up again before taking its locks.
      throughputRules: throughputRows.map((raw) => limitRowCodec.decode(raw)),
    };
  }

  private static readonly query = new PreparedQuery((database) =>
    buildContextQuery(database, {}).prepare("archestra_proxy_request_context"),
  );

  private static readonly proxyQuery = new PreparedQuery((database) => {
    const policy = schema.resourcePermissionPoliciesTable;
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    const teamIds = database.$with("proxy_agent_team_ids").as(
      database
        .select({
          id: sql<string>`granted.value->'subject'->>'id'`.as("id"),
          position: sql<number>`min(granted.position)::integer`.as("position"),
        })
        .from(policy)
        .crossJoin(
          sql`jsonb_array_elements(${policy.grants}) WITH ORDINALITY AS granted(value, position)`,
        )
        .where(
          and(
            eq(policy.organizationId, sql.placeholder("organizationId")),
            eq(policy.scope, sql.placeholder("agentId")),
            sql`${policy.resource} IN ('agent', 'mcpGateway')`,
            sql`granted.value->'actions' ? 'read'`,
            sql`granted.value->'subject'->>'type' = 'team'`,
          ),
        )
        .groupBy(sql`granted.value->'subject'->>'id'`),
    );
    // SPDX-SnippetEnd
    const teamId = sql`"proxy_agent_team_ids"."id"`;
    const teamPosition = sql`"proxy_agent_team_ids"."position"`;
    const limits = schema.limitsTable;
    const defaults = schema.environmentDefaultUserLimitsTable;
    const teams = schema.teamsTable;
    const billingTeamId = sql.placeholder("billingTeamId");
    // Team limits apply to a call only through a team it belongs to: the
    // credential's billing team, or else the agent's teams the authenticated
    // caller is in, directly or through a sub-team. Another team's limit on a
    // shared agent never reaches this call.
    const teamArray = sql`ARRAY(
      SELECT ${teamId} FROM ${teamIds} WHERE ${billingTeamId}::text IS NULL
        AND ${teamId} IN (${callerTeamIdsQuery(sql.placeholder("teamMemberUserId"))})
      UNION ALL SELECT ${billingTeamId}::text WHERE ${billingTeamId}::text IS NOT NULL
    )`;
    return buildContextQuery(database.with(teamIds), {
      runtimeCandidates: runtimeCandidatesSelection(),
      agentTeamIds: sql<
        string[]
      >`(SELECT coalesce(jsonb_agg(${teamId} ORDER BY ${teamPosition}, ${teamId}), '[]'::jsonb) FROM ${teamIds})`,
      limitTeamIds: sql<string[]>`to_jsonb(${teamArray})`,
      agentTeams: sql<TraceTeam[]>`(
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', ${qualified(teams.id)}, 'name', ${qualified(teams.name)},
          'labels', ${traceTeamLabels()}
        ) ORDER BY ${teamPosition}, ${teamId}), '[]'::jsonb)
        FROM ${teams} INNER JOIN ${teamIds} ON ${qualified(teams.id)} = ${teamId}
        WHERE ${qualified(teams.organizationId)} = ${sql.placeholder("organizationId")}
      )`,
      limitRows: sql<Array<Record<string, unknown>>>`(
        SELECT coalesce(jsonb_agg(to_jsonb(request_limits)), '[]'::jsonb)
        FROM (SELECT ${limitRowCodec.selection}, ${scopedCleanupDueCondition()} AS "cleanupDue"
          FROM ${limits} WHERE ${and(
            limitEntitiesCondition({ team: teamArray }),
            or(eq(limits.limitType, "token_cost"), scopedCleanupDueCondition()),
          )}) AS request_limits
      )`,
      throughputRows: sql<Array<Record<string, unknown>>>`(
        SELECT coalesce(jsonb_agg(to_jsonb(request_rules) ORDER BY request_rules.id), '[]'::jsonb)
        FROM (SELECT ${limitRowCodec.selection} FROM ${limits} WHERE ${and(
          limitEntitiesCondition({ team: teamArray }),
          throughputRuleCondition(),
        )}) AS request_rules
      )`,
      defaultUserLimitRow: sql<Record<string, unknown> | null>`(
        SELECT to_jsonb(request_default) FROM (
          SELECT ${defaultRowCodec.selection} FROM ${defaults}
          WHERE ${defaults.organizationId} = ${sql.placeholder("organizationId")}
            AND (${defaults.environmentId} = ${sql.placeholder("environmentId")} OR ${defaults.environmentId} IS NULL)
          ORDER BY ${defaults.environmentId} NULLS LAST LIMIT 1
        ) AS request_default
      )`,
    }).prepare("archestra_proxy_request_state");
  });
}

const limitRowCodec = new JsonRowCodec(schema.limitsTable);
const defaultRowCodec = new JsonRowCodec(
  schema.environmentDefaultUserLimitsTable,
);

function runtimeCandidatesSelection() {
  const runs = schema.agentRunsTable;
  const workspaces = schema.agentWorkspacesTable;
  // Keep two runs per credential before applying any organization or actor
  // checks. Filtering first could turn an ambiguous binding into a valid one.
  return sql<
    RuntimeCandidate[]
  >`CASE WHEN ${sql.placeholder("includeRuntime")}::boolean THEN (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'virtualKeyId', requested_runtime_key.id,
      'run', jsonb_build_object(
        'organizationId', runtime_run.organization_id,
        'agentId', runtime_run.agent_id, 'actorKind', runtime_run.actor_kind,
        'actorId', runtime_run.actor_id, 'actorUserId', runtime_run.actor_user_id,
        'taskId', runtime_run.task_id, 'workloadName', runtime_run.workload_name
      ),
      'workspace', CASE WHEN runtime_workspace.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', runtime_workspace.id, 'organizationId', runtime_workspace.organization_id,
        'agentId', runtime_workspace.agent_id, 'actorKind', runtime_workspace.actor_kind,
        'actorId', runtime_workspace.actor_id, 'workloadName', runtime_workspace.workload_name,
        'state', runtime_workspace.state
      ) END
    )), '[]'::jsonb)
    FROM (VALUES (${sql.placeholder("runtimeKey1")}::text),
      (${sql.placeholder("runtimeKey2")}::text)) AS requested_runtime_key(id)
    CROSS JOIN LATERAL (
      SELECT organization_id, agent_id, actor_kind, actor_id, actor_user_id, task_id, workload_name
      FROM ${runs} WHERE ${qualified(runs.virtualApiKeyId)} = requested_runtime_key.id::uuid LIMIT 2
    ) AS runtime_run
    LEFT JOIN ${workspaces} AS runtime_workspace
      ON runtime_workspace.workload_name = runtime_run.workload_name
    WHERE requested_runtime_key.id IS NOT NULL
  ) ELSE '[]'::jsonb END`;
}

function buildContextQuery<T extends SelectedFields>(
  database: Pick<ReturnType<typeof getDb>, "select">,
  extra: T,
) {
  const model = schema.modelsTable;
  const policy = schema.resourcePermissionPoliciesTable;
  const teams = schema.teamsTable;
  const members = schema.teamMembersTable;
  const labels = schema.teamLabelsTable;
  const keys = schema.labelKeysTable;
  const values = schema.labelValuesTable;
  const organizationId = sql.placeholder("organizationId");
  const userId = sql.placeholder("userId");
  const labelSources = [
    {
      table: labels,
      owner: teams,
      column: labels.teamId,
      ownerId: teams.id,
      scope: sql`${teams.organizationId} = ${organizationId}`,
      id: sql.placeholder("billingTeamId"),
      priority: 2,
    },
    {
      table: schema.virtualApiKeyLabelsTable,
      owner: schema.virtualApiKeysTable,
      column: schema.virtualApiKeyLabelsTable.virtualApiKeyId,
      ownerId: schema.virtualApiKeysTable.id,
      scope: sql`${schema.virtualApiKeysTable.organizationId} = ${organizationId}`,
      id: sql.placeholder("virtualKeyId"),
      priority: 3,
    },
    {
      table: schema.oauthClientLabelsTable,
      owner: schema.oauthClientsTable,
      column: schema.oauthClientLabelsTable.clientId,
      ownerId: schema.oauthClientsTable.id,
      scope: sql`${schema.oauthClientsTable.metadata}->>'organizationId' = ${organizationId}`,
      id: sql.placeholder("oauthClientId"),
      priority: 3,
    },
  ];
  const attribution = labelSources.map(
    (source) => sql`SELECT ${keys.key} AS key, ${values.value} AS value,
        ${source.priority}::integer AS priority
        FROM ${source.table}
        INNER JOIN ${source.owner} ON ${source.column} = ${source.ownerId}
        INNER JOIN ${keys} ON ${source.table.keyId} = ${keys.id}
        INNER JOIN ${values} ON ${source.table.valueId} = ${values.id}
        WHERE ${source.column} = ${source.id} AND ${source.scope}`,
  );
  return database
    .select({
      ...extra,
      model: {
        id: model.id,
        provider: model.provider,
        modelId: model.modelId,
      },
      guardrails: getTableColumns(schema.guardrailsDeploymentTable),
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      modelPolicies: sql<
        Array<
          Pick<
            typeof policy.$inferSelect,
            "scope" | "grants" | "legacyOrganizationAudience"
          >
        >
      >`coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'scope', ${qualified(policy.scope)},
            'grants', ${qualified(policy.grants)},
            'legacyOrganizationAudience', ${qualified(policy.legacyOrganizationAudience)}
          )) FROM ${policy}
          WHERE ${qualified(policy.organizationId)} = ${organizationId}
            AND ${qualified(policy.resource)} = 'llmModel'
            AND ${qualified(policy.scope)} IN ('*', ${qualified(model.id)}::text)
        ), '[]'::jsonb)`,
      // SPDX-SnippetEnd
      userTeams: sql<TraceTeam[]>`coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'id', ${qualified(teams.id)}, 'name', ${qualified(teams.name)},
            'labels', ${traceTeamLabels()}
          )) FROM ${teams}
          INNER JOIN ${members} ON ${qualified(members.teamId)} = ${qualified(teams.id)}
          WHERE ${qualified(members.userId)} = ${userId}
            AND ${qualified(teams.organizationId)} = ${organizationId}
        ), '[]'::jsonb)`,
      attributionRows: sql<
        Array<{ key: string; value: string; priority: number }>
      >`(
          SELECT coalesce(jsonb_agg(to_jsonb(request_labels)), '[]'::jsonb)
          FROM (${sql.join(attribution, sql` UNION ALL `)}) AS request_labels
        )`,
    })
    .from(sql`(VALUES (1)) AS proxy_context(present)`)
    .leftJoin(
      model,
      and(
        eq(model.provider, sql.placeholder("provider")),
        eq(model.modelId, sql.placeholder("modelId")),
      ),
    )
    .leftJoin(
      schema.guardrailsDeploymentTable,
      eq(schema.guardrailsDeploymentTable.id, "global"),
    );
}

/**
 * The teams a user is in, plus every ancestor of those teams: membership in a
 * sub-team counts as membership in its parents, as it does for access.
 */
function callerTeamIdsQuery(userId: unknown) {
  const members = schema.teamMembersTable;
  const teams = schema.teamsTable;
  return sql`WITH RECURSIVE caller_teams(id) AS (
      SELECT ${qualified(members.teamId)} FROM ${members}
      WHERE ${qualified(members.userId)} = ${userId}::text
      UNION SELECT ${qualified(teams.parentId)} FROM ${teams}
      INNER JOIN caller_teams ON ${qualified(teams.id)} = caller_teams.id
      WHERE ${qualified(teams.parentId)} IS NOT NULL
    ) SELECT id FROM caller_teams`;
}

function traceTeamLabels() {
  const labels = schema.teamLabelsTable;
  const keys = schema.labelKeysTable;
  const values = schema.labelValuesTable;
  return sql<LabelWithDetails[]>`coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'keyId', ${qualified(labels.keyId)}, 'valueId', ${qualified(labels.valueId)},
      'key', coalesce(${qualified(keys.key)}, ''), 'value', coalesce(${qualified(values.value)}, '')
    ) ORDER BY ${qualified(keys.key)})
    FROM ${labels}
    LEFT JOIN ${keys} ON ${qualified(labels.keyId)} = ${qualified(keys.id)}
    LEFT JOIN ${values} ON ${qualified(labels.valueId)} = ${qualified(values.id)}
    WHERE ${qualified(labels.teamId)} = ${qualified(schema.teamsTable.id)}
  ), '[]'::jsonb)`;
}

export type ProxyRequestContext = Awaited<
  ReturnType<typeof ProxyRequestContextModel.read>
>;

export type ProxyRequestState = Awaited<
  ReturnType<typeof ProxyRequestContextModel.readForProxy>
>;
