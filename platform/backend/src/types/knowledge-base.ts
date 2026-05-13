import { z } from "zod";

/**
 * Object-level visibility for knowledge sources.
 *
 * - `org-wide`: any user in the organization can access.
 * - `team-scoped`: only members of the assigned teams can access.
 * - `auto-sync-permissions`: ACL is synced per-document from the upstream
 *   source system (e.g. Jira, Confluence) and enforced at query time.
 *   Only supported by connectors that implement permission extraction
 *   and gated behind the knowledge-base enterprise license.
 */
export const KnowledgeSourceVisibilitySchema = z.enum([
  "org-wide",
  "team-scoped",
  "auto-sync-permissions",
]);
export type KnowledgeSourceVisibility = z.infer<
  typeof KnowledgeSourceVisibilitySchema
>;

/**
 * Connector types that support `auto-sync-permissions` visibility today.
 * Add a connector here only after wiring up its permission-extraction logic
 * AND populating `ConnectorDocument.permissions` during sync.
 */
export const AUTO_SYNC_PERMISSIONS_SUPPORTED_CONNECTOR_TYPES = [
  "jira",
  "confluence",
] as const;

export type AutoSyncPermissionsSupportedConnectorType =
  (typeof AUTO_SYNC_PERMISSIONS_SUPPORTED_CONNECTOR_TYPES)[number];

export function connectorTypeSupportsAutoSyncPermissions(
  connectorType: string,
): connectorType is AutoSyncPermissionsSupportedConnectorType {
  return (
    AUTO_SYNC_PERMISSIONS_SUPPORTED_CONNECTOR_TYPES as readonly string[]
  ).includes(connectorType);
}
