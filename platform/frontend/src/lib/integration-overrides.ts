"use client";

import {
  allowedFromCatalog,
  builtInProviderLabel,
  CONNECTOR_TYPE_LABELS,
  type ConnectorType,
  integrationLabel,
  isResourceAllowed,
  MESSAGING_CHANNEL_LABELS,
  type MessagingChannelId,
  type ModelProviderOverrides,
  type SupportedProvider,
  SupportedProviders,
} from "@archestra/shared";
import { useMemo } from "react";
import { useOrganization } from "@/lib/organization.query";
import { useMyResourceAccess } from "@/lib/role-resource-access.query";

/**
 * Which entries of a built-in catalog the signed-in user's role allows.
 *
 * The lists live on the role (see Settings → Roles), so what a picker offers
 * depends on who is looking. Model providers additionally carry an
 * organization-wide name — see {@link useModelProviderCatalog}.
 */
export type IntegrationCatalog<Id extends string> = {
  /** Entries this role may not use — never offer these anywhere. */
  isHidden: (id: Id) => boolean;
  /** Every catalog id this role may use, in catalog order. */
  visibleIds: Id[];
};

/** A catalog whose entries the organization also renames. */
export type NamedIntegrationCatalog<Id extends string> =
  IntegrationCatalog<Id> & {
    overrides: ModelProviderOverrides | null;
    /** The organization's name for an entry, or the built-in one. */
    label: (id: Id) => string;
  };

export function useModelProviderCatalog(): NamedIntegrationCatalog<SupportedProvider> {
  const { data: organization } = useOrganization();
  const { modelProviders } = useMyResourceAccess();
  const overrides = organization?.modelProviderOverrides ?? null;
  return useMemo(
    () => ({
      ...buildCatalog(modelProviders, SupportedProviders),
      overrides,
      label: (id: SupportedProvider) =>
        integrationLabel(overrides, id, builtInProviderLabel(id)),
    }),
    [overrides, modelProviders],
  );
}

export function useMessagingChannelCatalog(): IntegrationCatalog<MessagingChannelId> {
  const { messagingChannels } = useMyResourceAccess();
  return useMemo(
    () =>
      buildCatalog(
        messagingChannels,
        Object.keys(MESSAGING_CHANNEL_LABELS) as MessagingChannelId[],
      ),
    [messagingChannels],
  );
}

export function useKnowledgeConnectorCatalog(): IntegrationCatalog<ConnectorType> {
  const { knowledgeConnectors } = useMyResourceAccess();
  return useMemo(
    () =>
      buildCatalog(
        knowledgeConnectors,
        Object.keys(CONNECTOR_TYPE_LABELS) as ConnectorType[],
      ),
    [knowledgeConnectors],
  );
}

// ===================================================================
// Internal
// ===================================================================

function buildCatalog<Id extends string>(
  allowed: readonly string[] | null,
  ids: readonly Id[],
): IntegrationCatalog<Id> {
  return {
    isHidden: (id) => !isResourceAllowed(allowed, id),
    visibleIds: allowedFromCatalog(allowed, ids),
  };
}
