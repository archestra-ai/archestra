import {
  builtInProviderLabel,
  CONNECTOR_TYPE_LABELS,
  type ConnectorType,
  type CopilotPlan,
  copilotPlanTurnedOffMessage,
  integrationLabel,
  isCopilotPlanHidden,
  isIntegrationHidden,
  isPersonalSubscriptionHidden,
  isProviderApiKeyHidden,
  MESSAGING_CHANNEL_LABELS,
  type MessagingChannelId,
  type ProviderPlan,
  personalSubscriptionTurnedOffMessage,
  providerApiKeyTurnedOffMessage,
  type SupportedProvider,
} from "@archestra/shared";
import OrganizationModel from "@/models/organization";
import { ApiError } from "@/types";

/**
 * Admins can switch entries of the built-in catalogs off (see the
 * `*_overrides` organization columns). Hiding has to be more than cosmetic:
 * these guards refuse to configure an entry the admin turned off, so a hidden
 * provider/channel/connector cannot be re-introduced through the API, the MCP
 * tools, or a stale browser tab.
 */

/**
 * Rejects setting up one GitHub Copilot plan when GitHub Copilot is off, or
 * when an admin turned off just this plan. Keys that exist keep working.
 */
export async function assertCopilotPlanAllowed(params: {
  organizationId: string;
  plan: CopilotPlan;
}): Promise<void> {
  await assertModelProviderAllowed({
    organizationId: params.organizationId,
    provider: "github-copilot",
  });
  const { modelProviderOverrides } =
    await OrganizationModel.getIntegrationOverrides(params.organizationId);
  if (!isCopilotPlanHidden(modelProviderOverrides, params.plan)) return;
  throw new ApiError(
    400,
    copilotPlanTurnedOffMessage(modelProviderOverrides, params.plan),
  );
}

/**
 * Rejects connecting a personal subscription (a ChatGPT, Claude Code,
 * SuperGrok, GitHub Copilot or Microsoft 365 Copilot sign-in) when its
 * provider is off, or when an admin turned off just its personal
 * subscriptions. Subscriptions that are connected keep working.
 */
export async function assertPersonalSubscriptionAllowed(params: {
  organizationId: string;
  provider: SupportedProvider;
}): Promise<void> {
  await assertModelProviderAllowed(params);
  const { modelProviderOverrides } =
    await OrganizationModel.getIntegrationOverrides(params.organizationId);
  if (!isPersonalSubscriptionHidden(modelProviderOverrides, params.provider)) {
    return;
  }
  throw new ApiError(
    400,
    personalSubscriptionTurnedOffMessage(
      modelProviderOverrides,
      params.provider,
    ),
  );
}

/**
 * Rejects setting up a key of a plan an admin turned off: an API key, a
 * personal subscription, or a GitHub Copilot enterprise plan.
 */
export async function assertProviderPlanAllowed(params: {
  organizationId: string;
  provider: SupportedProvider;
  plan: ProviderPlan;
}): Promise<void> {
  const { organizationId, provider, plan } = params;
  if (plan === "enterprise") {
    await assertCopilotPlanAllowed({ organizationId, plan });
  } else if (plan === "personal") {
    await assertPersonalSubscriptionAllowed({ organizationId, provider });
  } else {
    await assertProviderApiKeyAllowed({ organizationId, provider });
  }
}

/** Rejects configuring a messaging channel the admin hid. */
export async function assertMessagingChannelAllowed(params: {
  organizationId: string;
  channel: MessagingChannelId;
}): Promise<void> {
  const { messagingChannelOverrides } =
    await OrganizationModel.getIntegrationOverrides(params.organizationId);
  if (!isIntegrationHidden(messagingChannelOverrides, params.channel)) return;
  throw new ApiError(
    400,
    `${MESSAGING_CHANNEL_LABELS[params.channel]} is turned off for this organization. Ask an administrator to re-enable it under Settings → Agents → Available messaging channels.`,
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
export async function hiddenKnowledgeConnectorViolation(params: {
  organizationId: string;
  connectorType: string;
}): Promise<string | null> {
  const connectorType = params.connectorType as ConnectorType;
  const { knowledgeConnectorOverrides } =
    await OrganizationModel.getIntegrationOverrides(params.organizationId);
  if (!isIntegrationHidden(knowledgeConnectorOverrides, connectorType)) {
    return null;
  }
  const label = CONNECTOR_TYPE_LABELS[connectorType] ?? connectorType;
  return `${label} connectors are turned off for this organization. Ask an administrator to re-enable the connector type under Settings → Knowledge → Available connectors.`;
}

/**
 * Messaging channels the deployment's organization has switched off. The
 * ChatOps manager and the inbound email webhook run outside any authenticated
 * request, so they resolve the organization themselves rather than being
 * handed one.
 */
export async function getHiddenMessagingChannels(
  organizationId?: string,
): Promise<Set<MessagingChannelId>> {
  const { messagingChannelOverrides } =
    await OrganizationModel.getIntegrationOverrides(organizationId ?? null);
  const hidden = new Set<MessagingChannelId>();
  for (const [channel, override] of Object.entries(
    messagingChannelOverrides ?? {},
  ) as [MessagingChannelId, { hidden?: boolean } | undefined][]) {
    if (override?.hidden) hidden.add(channel);
  }
  return hidden;
}

// ===================================================================
// Internal
// ===================================================================

/** Rejects creating or updating a key for a model provider the admin hid. */
async function assertModelProviderAllowed(params: {
  organizationId: string;
  provider: SupportedProvider;
}): Promise<void> {
  const { modelProviderOverrides } =
    await OrganizationModel.getIntegrationOverrides(params.organizationId);
  if (!isIntegrationHidden(modelProviderOverrides, params.provider)) return;
  throw new ApiError(
    400,
    `${integrationLabel(
      modelProviderOverrides,
      params.provider,
      builtInProviderLabel(params.provider),
    )} is turned off for this organization. Ask an administrator to re-enable it under Settings → LLM → Model providers.`,
  );
}

/**
 * Rejects adding or changing an ordinary API key when its provider is off, or
 * when an admin turned off just its API keys. Keys that exist keep working.
 */
async function assertProviderApiKeyAllowed(params: {
  organizationId: string;
  provider: SupportedProvider;
}): Promise<void> {
  await assertModelProviderAllowed(params);
  const { modelProviderOverrides } =
    await OrganizationModel.getIntegrationOverrides(params.organizationId);
  if (!isProviderApiKeyHidden(modelProviderOverrides, params.provider)) return;
  throw new ApiError(
    400,
    providerApiKeyTurnedOffMessage(modelProviderOverrides, params.provider),
  );
}
