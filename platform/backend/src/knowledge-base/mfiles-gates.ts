import config from "@/config";

/**
 * The M-Files connector's two beta gates, shared by every write path that can
 * create or reconfigure a connector — the REST routes and the Archestra MCP
 * tools. They live here rather than beside one caller because a gate enforced
 * on only one of those paths is not a gate: the MCP tools are as shipped as
 * the API.
 *
 * Each returns the violation message, or null when the write is allowed, so
 * callers keep their own error convention (routes throw `ApiError`, MCP tools
 * return `errorResult`).
 */

const MFILES_CONNECTOR_DISABLED_MESSAGE =
  "The M-Files connector is not enabled on this deployment";

const MFILES_OAUTH_DISABLED_MESSAGE =
  "The M-Files Application Account authentication method is not enabled on this deployment";

/** Loose shape: the MCP tools accept a free-form config object. */
type MFilesAuthShape =
  | { type?: string; authMethod?: string | null }
  | null
  | undefined;

/**
 * Blocks creating an M-Files connector while the connector beta gate is off.
 * Creation only — an existing connector keeps syncing and stays editable if
 * the flag is turned off later.
 *
 * @public — shared by the REST create route and the MCP create tool
 */
export function mfilesConnectorGateViolation(
  connectorType: string,
): string | null {
  if (connectorType !== "mfiles") return null;
  if (config.kb.mfilesConnectorEnabled) return null;
  return MFILES_CONNECTOR_DISABLED_MESSAGE;
}

/**
 * Blocks selecting the Application Account (OAuth client-credentials) method
 * while its own gate is off. `existingConfig` grandfathers a connector already
 * using the method, so one created while the gate was on stays editable after
 * it is turned off; switching a password-token connector to OAuth is still
 * blocked.
 *
 * @public — shared by the REST create/update routes and the MCP create/update tools
 */
export function mfilesAuthMethodGateViolation(params: {
  nextConfig: MFilesAuthShape;
  existingConfig?: MFilesAuthShape;
}): string | null {
  if (config.kb.mfilesOauthEnabled) return null;
  const { nextConfig, existingConfig } = params;
  if (nextConfig?.type !== "mfiles") return null;
  if (nextConfig.authMethod !== "oauth_client_credentials") return null;
  if (
    existingConfig?.type === "mfiles" &&
    existingConfig.authMethod === "oauth_client_credentials"
  ) {
    return null;
  }
  return MFILES_OAUTH_DISABLED_MESSAGE;
}
