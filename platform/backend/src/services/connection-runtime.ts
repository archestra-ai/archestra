import {
  isIntegrationHidden,
  OPENCODE_PASSTHROUGH_PROVIDER_ROUTES,
  OPENCODE_PRIMARY_PROVIDERS,
} from "@archestra/shared";
import { INSTALLER_CLIENT_LABELS } from "@archestra/shared/connection-setup";
import { userHasPermission } from "@/auth";
import config from "@/config";
import AgentModel from "@/models/agent";
import ConnectionSetupModel from "@/models/connection-setup";
import MemberModel from "@/models/member";
import OrganizationModel from "@/models/organization";
import TeamModel from "@/models/team";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { ApiError, GATEWAY_CAPABLE_AGENT_TYPES } from "@/types";
import { getVirtualKeyProviderCatalog } from "./agent-connection-setup/credentials/primary-providers";
import {
  type ManagedRuntimeCatalog,
  publicManagedCatalog,
} from "./agent-connection-setup/payloads/opencode-primary-config";
import { verifyConnectionRuntimeToken } from "./connection-runtime-token";
import { ResourcePermissions } from "./resource-permissions";

/** Shared by artifact delivery and client binding provenance; checks live grants. */
export async function authenticateConnectionRuntime(token: string) {
  const setupId = verifyConnectionRuntimeToken({
    token,
    secret: config.auth.secret ?? "",
  });
  if (!setupId) throw new ApiError(401, "Invalid runtime update credential");
  const setup = await ConnectionSetupModel.findById(setupId);
  if (
    !setup?.consumedAt ||
    setup.revokedAt ||
    !["opencode", "kilo"].includes(setup.clientId)
  ) {
    throw new ApiError(403, "Installed connection is no longer available");
  }
  const members = await MemberModel.findByUserIdsInOrganization({
    organizationId: setup.organizationId,
    userIds: [setup.userId],
  });
  if (!members.length)
    throw new ApiError(403, "Installed connection is no longer available");
  if (setup.mcpGatewayId) {
    const canUse = await ResourcePermissions.allows({
      userId: setup.userId,
      organizationId: setup.organizationId,
      resource: "mcpGateway",
      scope: setup.mcpGatewayId,
      action: "use",
    });
    const gateway = canUse
      ? await AgentModel.findById(setup.mcpGatewayId)
      : null;
    if (
      !gateway ||
      gateway.organizationId !== setup.organizationId ||
      !GATEWAY_CAPABLE_AGENT_TYPES.some((type) => type === gateway.agentType)
    ) {
      throw new ApiError(403, "Installed connection is no longer available");
    }
  }
  if (setup.llmProxyId) {
    const canRead = await userHasPermission(
      setup.userId,
      setup.organizationId,
      "llmProxy",
      "read",
    );
    const proxy = canRead ? await AgentModel.findById(setup.llmProxyId) : null;
    if (
      !proxy ||
      proxy.organizationId !== setup.organizationId ||
      proxy.agentType !== "llm_proxy"
    )
      throw new ApiError(403, "Installed connection is no longer available");
  }
  return {
    setupId,
    organizationId: setup.organizationId,
    userId: setup.userId,
    clientId: setup.clientId as "opencode" | "kilo",
    mcpGatewayId: setup.mcpGatewayId,
    llmProxyId: setup.llmProxyId,
    virtualApiKeyId: setup.virtualApiKeyId,
    provider: setup.provider,
    authMode: setup.proxyAuth,
    baseUrl: setup.baseUrl,
  };
}

/**
 * Read-only catalog for the installation's original proxy and key. Never
 * provisions a proxy, key, or setup-context exception.
 */
export async function loadManagedRuntimeCatalog(
  installation: Awaited<ReturnType<typeof authenticateConnectionRuntime>>,
): Promise<ManagedRuntimeCatalog | undefined> {
  if (!installation.llmProxyId || !installation.provider) return undefined;
  const ordinaryBaseUrl = ordinaryV1Base(installation.baseUrl);
  if (!ordinaryBaseUrl) throw unavailable();
  const organization = await OrganizationModel.getById(
    installation.organizationId,
  );
  if (!organization) throw unavailable();
  const passthrough =
    installation.authMode === "primary-providers" ||
    installation.authMode === "provider-key"
      ? OPENCODE_PASSTHROUGH_PROVIDER_ROUTES.map(
          (route) => route.provider,
        ).filter(
          (provider) =>
            !isIntegrationHidden(organization.modelProviderOverrides, provider),
        )
      : [];
  if (installation.authMode === "provider-key") {
    return publicManagedCatalog({
      passthroughProviders: passthrough,
      ordinaryBaseUrl,
      routingAgentId: installation.llmProxyId,
    });
  }
  if (!installation.virtualApiKeyId) throw unavailable();
  const key = await VirtualApiKeyModel.findById(installation.virtualApiKeyId);
  if (
    !key ||
    key.organizationId !== installation.organizationId ||
    key.authorId !== installation.userId ||
    key.keyType === "passthrough"
  ) {
    throw unavailable();
  }
  const primaryProviders = await getVirtualKeyProviderCatalog({
    supportedProviders: OPENCODE_PRIMARY_PROVIDERS,
    clientLabel: INSTALLER_CLIENT_LABELS[installation.clientId],
    provider:
      installation.authMode === "virtual-key"
        ? installation.provider
        : undefined,
    mappedKeys:
      organization.connectionClientProviderKeys?.[installation.clientId] ??
      null,
    organizationId: installation.organizationId,
    userId: installation.userId,
    userTeamIds: await TeamModel.getUserTeamIds(installation.userId),
    virtualApiKeyId: key.id,
    allowEmpty: true,
  });
  return publicManagedCatalog({
    primaryProviders,
    passthroughProviders:
      installation.authMode === "primary-providers" ? passthrough : [],
    ordinaryBaseUrl,
    routingAgentId: installation.llmProxyId,
  });
}

function unavailable() {
  return new ApiError(403, "Installed connection is no longer available");
}

function ordinaryV1Base(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.username || url.password) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}/v1`;
  } catch {
    return null;
  }
}
