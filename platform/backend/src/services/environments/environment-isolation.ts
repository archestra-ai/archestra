import {
  ARCHESTRA_MCP_CATALOG_ID,
  PLAYWRIGHT_MCP_CATALOG_ID,
} from "@archestra/shared";
import { inArray, isNotNull, or, type SQL, sql } from "drizzle-orm";
import { schema } from "@/database";

/**
 * Environment isolation: an agent / MCP gateway assigned to environment `E` may
 * only see and use TOOLS and KNOWLEDGE that belong to `E`. A `null` environment
 * is the org "Default" environment — a real peer, not a wildcard — so matching is
 * strict equality (`IS NOT DISTINCT FROM`). Today every row is `null`/Default, so
 * existing deployments are unaffected until an admin assigns a non-default env.
 */

/**
 * Catalog ids whose tools bypass environment isolation: the built-in Archestra
 * control-plane server and the built-in Playwright server. Keyed on the stable
 * catalog id (NOT the tool-name prefix, which can be white-labelled).
 */
const ENVIRONMENT_EXEMPT_CATALOG_IDS = [
  ARCHESTRA_MCP_CATALOG_ID,
  PLAYWRIGHT_MCP_CATALOG_ID,
];

/**
 * SQL predicate selecting `tools` rows that belong to `agentEnvironmentId`'s
 * environment, or are exempt from isolation. A tool's environment is its catalog
 * item's environment (`tools.catalogId -> internal_mcp_catalog.environment_id`).
 *
 * Exempt (always visible):
 * - built-in catalogs (Archestra, Playwright)
 * - delegation tools (`delegateToAgentId` set) — explicitly assigned, no catalog
 *
 * NOT exempt: proxy-discovered / legacy rows (catalogId null AND delegate null);
 * they fall through and are excluded for any non-matching environment.
 *
 * @param tools pass an aliased tools table when the query aliases it.
 */
export function toolInEnvironmentPredicate(
  agentEnvironmentId: string | null,
  tools = schema.toolsTable,
): SQL {
  const catalog = schema.internalMcpCatalogTable;
  return or(
    inArray(tools.catalogId, ENVIRONMENT_EXEMPT_CATALOG_IDS),
    isNotNull(tools.delegateToAgentId),
    sql`exists (select 1 from ${catalog} where ${catalog.id} = ${tools.catalogId} and ${catalog.environmentId} is not distinct from ${agentEnvironmentId})`,
  ) as SQL;
}

/**
 * SQL predicate selecting `knowledge_base_connectors` rows that belong to
 * `agentEnvironmentId`'s environment (strict equality, null = Default). There are
 * no built-in connectors, so there are no exemptions.
 *
 * @param connectors pass an aliased connectors table when the query aliases it.
 */
export function connectorInEnvironmentPredicate(
  agentEnvironmentId: string | null,
  connectors = schema.knowledgeBaseConnectorsTable,
): SQL {
  return sql`${connectors.environmentId} is not distinct from ${agentEnvironmentId}`;
}
