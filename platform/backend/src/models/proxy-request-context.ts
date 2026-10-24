import type { SupportedProvider } from "@archestra/shared";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { schema } from "@/database";
import { PreparedQuery } from "@/database/prepared-query";
import { qualified } from "@/database/utils/qualified-column";
import type { LabelWithDetails } from "@/types/label";

/**
 * Independent, read-only proxy metadata in one database round trip. A new
 * snapshot is read after authentication on every request. No result survives
 * that request; quota admission and writes still read their own current state.
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

  private static readonly query = new PreparedQuery((database) => {
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
        userTeams: sql<
          Array<{
            id: string;
            name: string;
            labels: LabelWithDetails[];
          }>
        >`coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'id', ${qualified(teams.id)}, 'name', ${qualified(teams.name)},
            'labels', coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                'keyId', ${qualified(labels.keyId)},
                'valueId', ${qualified(labels.valueId)},
                'key', coalesce(${qualified(keys.key)}, ''),
                'value', coalesce(${qualified(values.value)}, '')
              ) ORDER BY ${qualified(keys.key)})
              FROM ${labels}
              LEFT JOIN ${keys} ON ${qualified(labels.keyId)} = ${qualified(keys.id)}
              LEFT JOIN ${values} ON ${qualified(labels.valueId)} = ${qualified(values.id)}
              WHERE ${qualified(labels.teamId)} = ${qualified(teams.id)}
            ), '[]'::jsonb)
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
      )
      .prepare("archestra_proxy_request_context");
  });
}

export type ProxyRequestContext = Awaited<
  ReturnType<typeof ProxyRequestContextModel.read>
>;
