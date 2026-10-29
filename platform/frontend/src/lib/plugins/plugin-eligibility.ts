import type { archestraApiTypes } from "@archestra/shared";

type PluginEligibilityFields = Pick<
  archestraApiTypes.GetPluginsResponses["200"][number],
  "clientType" | "enabled" | "approvedContentHash" | "contentHash"
>;

/**
 * Whether a connection setup for this client delivers the plugin: it is for
 * that client, enabled, and its current content is the approved one. The
 * Connect page, the approval page and the server seed of the approval page
 * all decide it here.
 */
export function isDeliverablePlugin(
  plugin: PluginEligibilityFields,
  clientId: string,
): boolean {
  return (
    plugin.clientType === clientId &&
    plugin.enabled &&
    plugin.approvedContentHash === plugin.contentHash
  );
}
