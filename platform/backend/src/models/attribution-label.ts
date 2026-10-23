import { sql } from "drizzle-orm";
import { schema } from "@/database";
import { PreparedQuery } from "@/database/prepared-query";

export default class AttributionLabelModel {
  /** One scoped query regardless of the number of labels on the principals. */
  static async findForRequest(params: {
    organizationId: string;
    billingTeamId?: string;
    virtualKeyId?: string;
    oauthClientId?: string;
  }): Promise<{ key: string; value: string; priority: number }[]> {
    if (
      params.billingTeamId === undefined &&
      params.virtualKeyId === undefined &&
      params.oauthClientId === undefined
    )
      return [];
    return AttributionLabelModel.forRequest.get().execute({
      organizationId: params.organizationId,
      billingTeamId: params.billingTeamId ?? null,
      virtualKeyId: params.virtualKeyId ?? null,
      oauthClientId: params.oauthClientId ?? null,
    });
  }

  private static readonly forRequest = new PreparedQuery((database) => {
    const sources = [
      {
        id: sql.placeholder("billingTeamId"),
        table: schema.teamLabelsTable,
        column: schema.teamLabelsTable.teamId,
        owner: schema.teamsTable,
        ownerId: schema.teamsTable.id,
        scope: sql`${schema.teamsTable.organizationId} = ${sql.placeholder("organizationId")}`,
        priority: 2,
      },
      {
        id: sql.placeholder("virtualKeyId"),
        table: schema.virtualApiKeyLabelsTable,
        column: schema.virtualApiKeyLabelsTable.virtualApiKeyId,
        owner: schema.virtualApiKeysTable,
        ownerId: schema.virtualApiKeysTable.id,
        scope: sql`${schema.virtualApiKeysTable.organizationId} = ${sql.placeholder("organizationId")}`,
        priority: 3,
      },
      {
        id: sql.placeholder("oauthClientId"),
        table: schema.oauthClientLabelsTable,
        column: schema.oauthClientLabelsTable.clientId,
        owner: schema.oauthClientsTable,
        ownerId: schema.oauthClientsTable.id,
        scope: sql`${schema.oauthClientsTable.metadata}->>'organizationId' = ${sql.placeholder("organizationId")}`,
        priority: 3,
      },
    ];
    const queries = sources.map(
      (source) => sql`SELECT ${schema.labelKeysTable.key} AS key,
        ${schema.labelValuesTable.value} AS value, ${source.priority}::integer AS priority
        FROM ${source.table}
        INNER JOIN ${source.owner} ON ${source.column} = ${source.ownerId}
        INNER JOIN ${schema.labelKeysTable} ON ${source.table.keyId} = ${schema.labelKeysTable.id}
        INNER JOIN ${schema.labelValuesTable} ON ${source.table.valueId} = ${schema.labelValuesTable.id}
        WHERE ${source.column} = ${source.id} AND ${source.scope}`,
    );
    return database
      .select({
        key: sql<string>`key`,
        value: sql<string>`value`,
        priority: sql<number>`priority`,
      })
      .from(sql`(${sql.join(queries, sql` UNION ALL `)}) AS request_labels`)
      .prepare("archestra_request_attribution_labels");
  });
}
