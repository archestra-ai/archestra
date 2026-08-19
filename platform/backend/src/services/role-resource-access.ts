import {
  builtInProviderLabel,
  CONNECTOR_TYPE_LABELS,
  type ConnectorType,
  integrationLabel,
  isResourceAllowed,
  MESSAGING_CHANNEL_LABELS,
  type MessagingChannelId,
  type RoleResourceAccess,
  type SupportedProvider,
} from "@archestra/shared";
import MemberModel from "@/models/member";
import OrganizationModel from "@/models/organization";
import RoleResourceAccessModel from "@/models/role-resource-access";
import { ApiError } from "@/types";

/**
 * Roles carry an allow-list per built-in catalog (see the `role_resource_access`
 * table). The guards here refuse to configure an entry the caller's role does
 * not allow, so a restriction cannot be walked around through the API, the MCP
 * tools, or a stale browser tab.
 *
 * A role with no list for a catalog is unrestricted, so the guards are a no-op
 * for every organization that has not set anything up.
 */

/**
 * The allow-lists the user's role carries, defaulting to unrestricted.
 *
 * When no role can be resolved — `userId` is absent (a headless agent
 * execution reaching an MCP tool) or the caller holds no member record — this
 * falls back to the organization-wide union rather than to "everything". That
 * is the same "is this allowed to anybody" question the ChatOps manager asks,
 * and it keeps a caller without a role from out-reaching every role there is.
 */
export async function getUserResourceAccess(params: {
  userId: string | null | undefined;
  organizationId: string;
}): Promise<RoleResourceAccess> {
  const member = params.userId
    ? await MemberModel.getByUserId(params.userId, params.organizationId)
    : null;
  if (!member) {
    return RoleResourceAccessModel.getOrganizationUnion(params.organizationId);
  }
  return RoleResourceAccessModel.getForRole({
    organizationId: params.organizationId,
    role: member.role,
  });
}

/** Whether the user's role may use a messaging channel, without throwing. */
export async function isMessagingChannelAllowed(params: {
  userId: string | null | undefined;
  organizationId: string;
  channel: MessagingChannelId;
}): Promise<boolean> {
  const { messagingChannels } = await getUserResourceAccess(params);
  return isResourceAllowed(messagingChannels, params.channel);
}

/** Rejects creating or updating a key for a provider the caller's role excludes. */
export async function assertModelProviderAllowed(params: {
  userId: string | null | undefined;
  organizationId: string;
  provider: SupportedProvider;
}): Promise<void> {
  const { modelProviders } = await getUserResourceAccess(params);
  if (isResourceAllowed(modelProviders, params.provider)) return;

  const { modelProviderOverrides } =
    await OrganizationModel.getModelProviderOverrides(params.organizationId);
  throw new ApiError(
    400,
    `${integrationLabel(
      modelProviderOverrides,
      params.provider,
      builtInProviderLabel(params.provider),
    )} is not available to your role. ${ASK_AN_ADMIN}`,
  );
}

/** Rejects configuring a messaging channel the caller's role excludes. */
export async function assertMessagingChannelAllowed(params: {
  userId: string | null | undefined;
  organizationId: string;
  channel: MessagingChannelId;
}): Promise<void> {
  const { messagingChannels } = await getUserResourceAccess(params);
  if (isResourceAllowed(messagingChannels, params.channel)) return;
  throw new ApiError(
    400,
    `${MESSAGING_CHANNEL_LABELS[params.channel]} is not available to your role. ${ASK_AN_ADMIN}`,
  );
}

/**
 * The reason a connector of this type may not be created, or null when it may.
 * Message-returning rather than throwing because both shipped creation paths —
 * the REST route and the `create_knowledge_connector` MCP tool — report
 * refusals in their own shape.
 *
 * @public — shared by the REST create route and the MCP create tool
 */
export async function disallowedKnowledgeConnectorViolation(params: {
  userId: string | null | undefined;
  organizationId: string;
  connectorType: string;
}): Promise<string | null> {
  const { knowledgeConnectors } = await getUserResourceAccess(params);
  if (isResourceAllowed(knowledgeConnectors, params.connectorType)) return null;
  const connectorType = params.connectorType as ConnectorType;
  const label = CONNECTOR_TYPE_LABELS[connectorType] ?? connectorType;
  return `${label} connectors are not available to your role. ${ASK_AN_ADMIN}`;
}

/**
 * Messaging channels no role in the deployment's organization allows.
 *
 * The ChatOps manager and the inbound email webhook run outside any
 * authenticated request, so there is no role to resolve against and the
 * question becomes an organization-wide one: a channel keeps listening as long
 * as *some* role may still use it, and stops only once every role excludes it.
 */
export async function getDisallowedMessagingChannels(): Promise<
  Set<MessagingChannelId>
> {
  const { messagingChannels } =
    await RoleResourceAccessModel.getOrganizationUnion(null);
  if (messagingChannels == null) return new Set();
  return new Set(
    (Object.keys(MESSAGING_CHANNEL_LABELS) as MessagingChannelId[]).filter(
      (channel) => !messagingChannels.includes(channel),
    ),
  );
}

// ===================================================================
// Internal
// ===================================================================

const ASK_AN_ADMIN =
  "Ask an administrator to add it to your role under Settings → Roles.";
