import {
  ManagedResourceSchema,
  OPENCODE_PRIMARY_PROVIDERS,
  type Permissions,
  PROVIDER_MODEL_TIERS,
  PROVIDERS_REQUIRING_BASE_URL,
  providerRequiresPerUserCredential,
  ResourcePermissionActionSchema,
  type SupportedProvider,
} from "@archestra/shared";
import {
  CONNECTION_SETUP_MAX_SKILLS,
  INSTALLER_CLIENT_KEY_PROVIDERS,
  type InstallerClientId,
  isInstallerClientId,
  isOpenCodeFamilyClient,
  PLUGIN_DELIVERY_MAX_COUNT,
} from "@archestra/shared/connection-setup";
import { hasPermissions } from "@/lib/auth/auth.utils";
import type { CreateConnectionSetupBody } from "@/lib/connection-setup.query";
import type { PluginListItem } from "@/lib/plugins/plugin.query";
import { isDeliverablePlugin } from "@/lib/plugins/plugin-eligibility";
import type { ConnectClient } from "./clients";

type ConnectProxyAuth = NonNullable<CreateConnectionSetupBody["proxyAuth"]>;

/**
 * One setup payload, as the approval page keys it: the page prepares a setup
 * whenever this changes, and the server seed prepares the first one.
 */
export type ConnectionSetupInputs = {
  clientId: InstallerClientId;
  platform: NonNullable<CreateConnectionSetupBody["platform"]>;
  baseUrl: string;
  gatewayId: string | null;
  proxyId: string | null;
  provider: SupportedProvider | null;
  proxyAuth: ConnectProxyAuth | null;
  primaryKeyIds: string[] | null;
  model: string | null;
  skillIds: string[] | null;
  pluginIds: string[] | null;
};

/**
 * The key of a payload. The field order is part of the key: the page and the
 * server seed must write the same string for the same payload.
 */
export function connectionSetupInputsKey(inputs: ConnectionSetupInputs) {
  return JSON.stringify({
    clientId: inputs.clientId,
    platform: inputs.platform,
    baseUrl: inputs.baseUrl,
    gatewayId: inputs.gatewayId,
    proxyId: inputs.proxyId,
    provider: inputs.provider,
    proxyAuth: inputs.proxyAuth,
    primaryKeyIds: inputs.primaryKeyIds,
    model: inputs.model,
    skillIds: inputs.skillIds,
    pluginIds: inputs.pluginIds,
  });
}

/**
 * A short, stable digest of a payload key: two 32-bit FNV-1a-style hashes
 * with different offsets and multipliers, as 16 hex digits. The server seed
 * hands the page this instead of the key, which lists every selected skill
 * id; both sides compute it from the same key. Synchronous on purpose: the
 * page compares it on its first render. It is not a cryptographic hash and
 * protects nothing: it only tells one page load's payload from another.
 */
export function connectionSetupKeyDigest(key: string): string {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return hex(a) + hex(b);
}

/**
 * The `POST /api/connection-setups` body for a payload key, or null when the
 * payload has nothing to set up.
 */
export function connectionSetupBody(
  key: string,
): CreateConnectionSetupBody | null {
  const inputs = JSON.parse(key) as ConnectionSetupInputs;
  let skills: CreateConnectionSetupBody["skills"];
  if (inputs.skillIds && inputs.skillIds.length > 0) {
    // ttlDays is null because the marketplace the client clones from must
    // outlive the one-time setup token. It only applies on the snapshot
    // path (a setup that also delivers plugins); the shared marketplace URL
    // this normally renders has no expiry to set.
    skills = { skillIds: inputs.skillIds, ttlDays: null };
  }
  if (
    !inputs.gatewayId &&
    !inputs.proxyId &&
    !skills &&
    (!inputs.pluginIds || inputs.pluginIds.length === 0)
  ) {
    return null;
  }
  return {
    clientId: inputs.clientId,
    platform: inputs.platform,
    baseUrl: inputs.baseUrl,
    mcpGatewayId: inputs.gatewayId ?? undefined,
    llmProxyId: inputs.proxyId ?? undefined,
    provider:
      inputs.proxyAuth === "primary-providers"
        ? undefined
        : (inputs.provider ?? undefined),
    proxyAuth: inputs.proxyAuth ?? undefined,
    model: inputs.model ?? undefined,
    skills,
    ...(inputs.pluginIds ? { pluginIds: inputs.pluginIds } : {}),
  };
}

/**
 * The payload the approval page prepares first, from the parts the server
 * seed read: the page's defaults (every skill and compatible plugin, the
 * default gateway, the LLM Proxy) with nothing chosen yet. Null when the page
 * would not prepare at once (a selection over a limit, a per-user account to
 * connect first, nothing to set up) or when the installer's request picked or
 * left out parts: the page then prepares in the browser as before.
 *
 * It mirrors `ConnectCommandPanel`'s derivation; a test renders the panel
 * from the same parts and pins its first payload to this one.
 */
export function firstConnectionSetupInputs(params: {
  client: ConnectClient;
  /** The installer's platform from the URL. */
  requestedPlatform: string | null;
  baseUrl: string;
  urlGatewayId: string | null;
  urlProviderId: string | null;
  organization: {
    connectionDefaultMcpGatewayId?: string | null;
    connectionSkillsEnabled?: boolean | null;
    connectionLlmProxyEnabled?: boolean | null;
    connectionPluginsEnabled?: boolean | null;
    connectionClientProviderKeys?: Record<
      string,
      { provider: string }[]
    > | null;
  };
  /** The providers the organization offers; null offers all. */
  shownProviders: readonly SupportedProvider[] | null;
  permissions: Permissions;
  /** Grants on scoped resources (`useHasPermissions` with a scope). */
  scopedCapabilities: { resource: string; action: string; scope: string }[];
  request: {
    exclude?: readonly string[] | null;
    gateway?: string | null;
    plugins?: readonly string[] | null;
  };
  defaultGatewayId: string | null;
  /** The gateway list as the page merges it: the first page, then the references. */
  gateways: { id: string }[];
  llmProxyId: string | null;
  skillNames: { data: { id: string }[]; total: number } | null;
  plugins: PluginListItem[] | null;
  availableKeys:
    | {
        id: string;
        provider: string;
        isPrimary: boolean;
        baseUrl?: string | null;
        requiresReauthentication?: boolean | null;
      }[]
    | null;
}): ConnectionSetupInputs | null {
  const { client, organization, request } = params;
  if (!isInstallerClientId(client.id)) return null;
  // Choices the installer's request carries change the selection after the
  // first render; the browser prepares those itself.
  if (
    (request.exclude?.length ?? 0) > 0 ||
    request.gateway ||
    request.plugins
  ) {
    return null;
  }
  // As `useHasPermissions`: role permissions, and for a check with a scope,
  // the grants on managed resources.
  const can = (resource: string, action: string) =>
    hasPermissions(params.permissions, { [resource]: [action] } as Permissions);
  const canAnywhere = (resource: string, action: string) =>
    ManagedResourceSchema.safeParse(resource).success &&
    ResourcePermissionActionSchema.safeParse(action).success
      ? params.scopedCapabilities.some(
          (grant) =>
            grant.resource === resource &&
            grant.action === action &&
            grant.scope === "*",
        )
      : can(resource, action);

  // Gateway (ConnectionFlow): URL, then admin default, then the member's
  // default, then the first listed.
  const canReadMcpGateway = can("mcpGateway", "read");
  const gatewayId = canReadMcpGateway
    ? (params.urlGatewayId ??
      organization.connectionDefaultMcpGatewayId ??
      params.defaultGatewayId ??
      params.gateways[0]?.id ??
      null)
    : null;
  const gateway = gatewayId
    ? (params.gateways.find((g) => g.id === gatewayId) ?? null)
    : null;

  const llmProxyEnabled = organization.connectionLlmProxyEnabled === true;
  const activeLlmProxyId =
    llmProxyEnabled && can("llmProxy", "read") ? params.llmProxyId : null;

  // Skills: all of them, when the page offers them.
  const skillsEnabled = organization.connectionSkillsEnabled === true;
  const canReadSkills = can("skill", "read");
  const skillsTotal = params.skillNames?.total ?? 0;
  const skillsEligible = skillsEnabled && canReadSkills && skillsTotal > 0;
  if (skillsEnabled && canReadSkills && !params.skillNames) return null;
  const allSkills = params.skillNames?.data ?? [];
  const includeSkills = skillsEligible && allSkills.length > 0;

  // Plugins: every deliverable one compatible with the platform.
  const pluginsEnabled = organization.connectionPluginsEnabled === true;
  const pluginsQueryEnabled =
    pluginsEnabled &&
    canAnywhere("plugin", "read") &&
    canAnywhere("plugin", "update");
  if (pluginsQueryEnabled && !params.plugins) return null;
  const plugins = (pluginsQueryEnabled ? (params.plugins ?? []) : []).filter(
    (plugin) => isDeliverablePlugin(plugin, client.id),
  );
  const requested = params.requestedPlatform;
  const platformOption =
    requested === "windows" ? "windows" : requested ? "macos" : null;
  if (!platformOption) return null;
  const setupPlatform: ConnectionSetupInputs["platform"] =
    requested === "linux" ? "linux" : platformOption;
  const requiredPluginPlatform =
    platformOption === "windows" ? "windows" : "posix";
  const selectedPlugins = plugins.filter((plugin) =>
    plugin.supportedPlatforms.includes(requiredPluginPlatform),
  );

  // Model routing.
  if (!params.availableKeys) return null;
  const availableKeys = params.availableKeys;
  const canAttribute = can("llmVirtualKey", "create");
  const adminMappedProviders = new Set(
    (organization.connectionClientProviderKeys?.[client.id] ?? []).map(
      (key) => key.provider,
    ),
  );
  const openCodeFamily = isOpenCodeFamilyClient(client.id);
  const proxyAuth: ConnectProxyAuth =
    client.id === "cursor" || openCodeFamily
      ? "primary-providers"
      : adminMappedProviders.size > 0 && canAttribute
        ? "virtual-key"
        : "provider-key";
  const allPrimaryProviders =
    (openCodeFamily || client.id === "cursor") &&
    proxyAuth === "primary-providers";
  const usableOpenCodeKeys = availableKeys.filter(
    (key) =>
      !key.requiresReauthentication &&
      (!PROVIDERS_REQUIRING_BASE_URL.has(key.provider as SupportedProvider) ||
        Boolean(key.baseUrl?.trim())),
  );
  const configuredProviders = new Set(
    (openCodeFamily ? usableOpenCodeKeys : availableKeys).map(
      (key) => key.provider,
    ),
  );
  const supported: SupportedProvider[] =
    client.id === "cursor"
      ? [...INSTALLER_CLIENT_KEY_PROVIDERS.cursor]
      : openCodeFamily && proxyAuth !== "provider-key"
        ? [...OPENCODE_PRIMARY_PROVIDERS]
        : client.proxy.kind === "custom"
          ? client.proxy.supportedProviders
          : [];
  const shown = params.shownProviders ? new Set(params.shownProviders) : null;
  const supportedProviders =
    shown && !allPrimaryProviders
      ? supported.filter((p) => shown.has(p))
      : supported;
  let providers: SupportedProvider[];
  if (allPrimaryProviders) {
    const backing =
      adminMappedProviders.size > 0
        ? adminMappedProviders
        : new Set(
            usableOpenCodeKeys
              .filter((key) => key.isPrimary)
              .map((key) => key.provider),
          );
    providers = supportedProviders.filter((p) => backing.has(p));
  } else if (proxyAuth !== "virtual-key") {
    providers = supportedProviders;
  } else {
    providers = supportedProviders.filter(
      (p) =>
        (adminMappedProviders.has(p) && configuredProviders.has(p)) ||
        providerRequiresPerUserCredential(p),
    );
  }
  const urlProvider = params.urlProviderId as SupportedProvider | null;
  const provider =
    urlProvider && providers.includes(urlProvider)
      ? urlProvider
      : (providers[0] ?? null);
  const providerIsPerUser =
    !allPrimaryProviders &&
    !!provider &&
    providerRequiresPerUserCredential(provider);
  const needsPerUserConnect =
    !!activeLlmProxyId &&
    providerIsPerUser &&
    !configuredProviders.has(provider);
  const supportsModelChoice =
    client.id === "copilot-cli" || client.id === "claude-desktop";
  const effectiveModel =
    supportsModelChoice && provider
      ? client.id === "claude-desktop"
        ? "claude-haiku-4-5-20251001"
        : PROVIDER_MODEL_TIERS[provider].normal
      : null;
  const effectiveProxyAuth: ConnectProxyAuth = providerIsPerUser
    ? "virtual-key"
    : proxyAuth;
  const hasProxy = activeLlmProxyId !== null;
  const cursorRoutingUnavailable =
    client.id === "cursor" && (!provider || !canAttribute);
  const primaryRoutingBlocked =
    hasProxy && allPrimaryProviders && client.id !== "cursor" && !canAttribute;
  const proxyActive =
    !!(activeLlmProxyId && provider) &&
    !cursorRoutingUnavailable &&
    !primaryRoutingBlocked;

  // The page's gates for preparing at once.
  const hasRunnableAnything = Boolean(
    gateway ||
      proxyActive ||
      includeSkills ||
      (pluginsEnabled && selectedPlugins.length),
  );
  const selectionProblem =
    (pluginsEnabled && selectedPlugins.length > PLUGIN_DELIVERY_MAX_COUNT) ||
    (includeSkills && skillsTotal > CONNECTION_SETUP_MAX_SKILLS);
  if (!hasRunnableAnything || needsPerUserConnect || selectionProblem) {
    return null;
  }

  return {
    clientId: client.id,
    platform: setupPlatform,
    baseUrl: params.baseUrl,
    gatewayId: gateway?.id ?? null,
    proxyId: proxyActive ? activeLlmProxyId : null,
    provider: proxyActive ? provider : null,
    proxyAuth: proxyActive ? effectiveProxyAuth : null,
    primaryKeyIds: allPrimaryProviders
      ? availableKeys
          .filter((key) => key.isPrimary)
          .map((key) => key.id)
          .sort()
      : null,
    model: proxyActive ? effectiveModel : null,
    skillIds: includeSkills ? allSkills.map((s) => s.id).sort() : null,
    pluginIds: pluginsEnabled
      ? selectedPlugins.map((plugin) => plugin.id).sort()
      : null,
  };
}
