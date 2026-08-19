import {
  builtInProviderLabel,
  CONNECTOR_TYPE_LABELS,
  type ConnectorType,
  integrationLabel,
  isIntegrationHidden,
  MESSAGING_CHANNEL_LABELS,
  type MessagingChannelId,
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

/** Rejects creating or updating a key for a model provider the admin hid. */
export async function assertModelProviderAllowed(params: {
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
    )} is turned off for this organization. Ask an administrator to re-enable it under Settings → LLM → Available model providers.`,
  );
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
    `${MESSAGING_CHANNEL_LABELS[params.channel]} is turned off for this organization. Ask an administrator to re-enable it under Settings → Chat → Available messaging channels.`,
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
export async function getHiddenMessagingChannels(): Promise<
  Set<MessagingChannelId>
> {
  const { messagingChannelOverrides } =
    await OrganizationModel.getIntegrationOverrides(null);
  const hidden = new Set<MessagingChannelId>();
  for (const [channel, override] of Object.entries(
    messagingChannelOverrides ?? {},
  ) as [MessagingChannelId, { hidden?: boolean } | undefined][]) {
    if (override?.hidden) hidden.add(channel);
  }
  return hidden;
}
