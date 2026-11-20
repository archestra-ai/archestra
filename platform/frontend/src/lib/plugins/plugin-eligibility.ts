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
    clientId !== "grok-build" &&
    plugin.clientType === clientId &&
    plugin.enabled &&
    plugin.approvedContentHash === plugin.contentHash
  );
}

/**
 * Whether the user may install the plugin: a `use` grant on it, or on every
 * plugin. Only such plugins are offered for a connection setup, and the
 * server refuses any other.
 */
export function canUsePlugin(
  grants: readonly { resource: string; action: string; scope: string }[],
  pluginId: string,
): boolean {
  return grants.some(
    (grant) =>
      grant.resource === "plugin" &&
      grant.action === "use" &&
      (grant.scope === "*" || grant.scope === pluginId),
  );
}

/** Whether the user may install any plugin at all. */
export function canUseAnyPlugin(
  grants: readonly { resource: string; action: string }[],
): boolean {
  return grants.some(
    (grant) => grant.resource === "plugin" && grant.action === "use",
  );
}
