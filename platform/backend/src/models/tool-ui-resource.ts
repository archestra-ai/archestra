import { type SQL, sql } from "drizzle-orm";
import { schema } from "@/database";

/**
 * SQL expression resolving a tool's MCP App `ui://` resource URI, or NULL when
 * the tool is not a UI app. Canonical `_meta.ui.resourceUri` first, then the
 * legacy flat `ui/resourceUri` key; both must use the `ui://` scheme. Shared by
 * the external-apps listing and the catalog list's `providesUi` flag so the two
 * never drift.
 */
export function toolUiResourceUriSql(): SQL<string | null> {
  const meta = schema.toolsTable.meta;
  return sql<string | null>`coalesce(
    case when ${meta}->'_meta'->'ui'->>'resourceUri' like 'ui://%' then ${meta}->'_meta'->'ui'->>'resourceUri' end,
    case when ${meta}->'_meta'->>'ui/resourceUri' like 'ui://%' then ${meta}->'_meta'->>'ui/resourceUri' end
  )`;
}
