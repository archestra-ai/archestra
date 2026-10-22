import { sql } from "drizzle-orm";
import db, { schema } from "@/database";

export default class AttributionLabelModel {
  /** One scoped query regardless of the number of labels on the principals. */
  static async findForRequest(params: {
    organizationId: string;
    billingTeamId?: string;
    virtualKeyId?: string;
    oauthClientId?: string;
  }): Promise<{ key: string; value: string; priority: number }[]> {
    const sources = [
      {
        id: params.billingTeamId,
        table: schema.teamLabelsTable,
        column: schema.teamLabelsTable.teamId,
        owner: schema.teamsTable,
        ownerId: schema.teamsTable.id,
        scope: sql`${schema.teamsTable.organizationId} = ${params.organizationId}`,
        priority: 2,
      },
      {
        id: params.virtualKeyId,
        table: schema.virtualApiKeyLabelsTable,
        column: schema.virtualApiKeyLabelsTable.virtualApiKeyId,
        owner: schema.virtualApiKeysTable,
        ownerId: schema.virtualApiKeysTable.id,
        scope: sql`${schema.virtualApiKeysTable.organizationId} = ${params.organizationId}`,
        priority: 3,
      },
      {
        id: params.oauthClientId,
        table: schema.oauthClientLabelsTable,
        column: schema.oauthClientLabelsTable.clientId,
        owner: schema.oauthClientsTable,
        ownerId: schema.oauthClientsTable.id,
        scope: sql`${schema.oauthClientsTable.metadata}->>'organizationId' = ${params.organizationId}`,
        priority: 3,
      },
    ].filter((source) => source.id !== undefined);
    if (!sources.length) return [];
    const queries = sources.map(
      (source) => sql`SELECT ${schema.labelKeysTable.key} AS key,
        ${schema.labelValuesTable.value} AS value, ${source.priority}::integer AS priority
        FROM ${source.table}
        INNER JOIN ${source.owner} ON ${source.column} = ${source.ownerId}
        INNER JOIN ${schema.labelKeysTable} ON ${source.table.keyId} = ${schema.labelKeysTable.id}
        INNER JOIN ${schema.labelValuesTable} ON ${source.table.valueId} = ${schema.labelValuesTable.id}
        WHERE ${source.column} = ${source.id} AND ${source.scope}`,
    );
    const result = await db.execute<{
      key: string;
      value: string;
      priority: number;
    }>(sql.join(queries, sql` UNION ALL `));
    return result.rows;
  }
}
