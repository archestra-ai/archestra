import { getTableColumns, sql } from "drizzle-orm";
import { schema } from "@/database";
import { qualified } from "@/database/utils/qualified-column";
import type { LabelGetResponse } from "@/types/label";

/** Gateway configuration and labels from the same database snapshot. */
export function gatewayAgentSelection() {
  return {
    ...getTableColumns(schema.agentsTable),
    labels: sql<LabelGetResponse[]>`coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'keyId', ${qualified(schema.agentLabelsTable.keyId)},
        'valueId', ${qualified(schema.agentLabelsTable.valueId)},
        'key', coalesce(${qualified(schema.labelKeysTable.key)}, ''),
        'value', coalesce(${qualified(schema.labelValuesTable.value)}, '')
      ) ORDER BY ${qualified(schema.labelKeysTable.key)})
      FROM ${schema.agentLabelsTable}
      LEFT JOIN ${schema.labelKeysTable}
        ON ${qualified(schema.agentLabelsTable.keyId)} = ${qualified(schema.labelKeysTable.id)}
      LEFT JOIN ${schema.labelValuesTable}
        ON ${qualified(schema.agentLabelsTable.valueId)} = ${qualified(schema.labelValuesTable.id)}
      WHERE ${qualified(schema.agentLabelsTable.agentId)} = ${qualified(schema.agentsTable.id)}
    ), '[]'::jsonb)`,
  };
}
