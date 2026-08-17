"use client";

import {
  CONNECTOR_TYPE_LABELS,
  type ConnectorType,
  type IntegrationOverride,
  integrationDescription,
  integrationLabel,
  isIntegrationHidden,
  MESSAGING_CHANNEL_LABELS,
  type MessagingChannelId,
  providerDisplayNames,
  type SupportedProvider,
  SupportedProviders,
} from "@archestra/shared";
import { useMemo } from "react";
import { useOrganization } from "@/lib/organization.query";

/**
 * Admin customization of the built-in catalogs, as the rest of the UI consumes
 * it: which entries to leave out, and what to call the ones that stay.
 */
export type IntegrationCatalog<Id extends string> = {
  overrides: Partial<Record<Id, IntegrationOverride>> | null;
  /** Entries the admin switched off — never offer these anywhere. */
  isHidden: (id: Id) => boolean;
  /** The admin's label for an entry, falling back to the built-in name. */
  label: (id: Id) => string;
  /** The admin's extra blurb for an entry, or null when they set none. */
  description: (id: Id) => string | null;
  /** Every catalog id the admin left switched on, in catalog order. */
  visibleIds: Id[];
};

export function useModelProviderCatalog(): IntegrationCatalog<SupportedProvider> {
  const { data: organization } = useOrganization();
  const overrides = organization?.modelProviderOverrides ?? null;
  return useMemo(
    () =>
      buildCatalog(
        overrides,
        SupportedProviders,
        (id) => providerDisplayNames[id],
      ),
    [overrides],
  );
}

export function useMessagingChannelCatalog(): IntegrationCatalog<MessagingChannelId> {
  const { data: organization } = useOrganization();
  const overrides = organization?.messagingChannelOverrides ?? null;
  return useMemo(
    () =>
      buildCatalog(
        overrides,
        Object.keys(MESSAGING_CHANNEL_LABELS) as MessagingChannelId[],
        (id) => MESSAGING_CHANNEL_LABELS[id],
      ),
    [overrides],
  );
}

export function useKnowledgeConnectorCatalog(): IntegrationCatalog<ConnectorType> {
  const { data: organization } = useOrganization();
  const overrides = organization?.knowledgeConnectorOverrides ?? null;
  return useMemo(
    () =>
      buildCatalog(
        overrides,
        Object.keys(CONNECTOR_TYPE_LABELS) as ConnectorType[],
        (id) => CONNECTOR_TYPE_LABELS[id],
      ),
    [overrides],
  );
}

// ===================================================================
// Internal
// ===================================================================

function buildCatalog<Id extends string>(
  overrides: Partial<Record<Id, IntegrationOverride>> | null,
  ids: readonly Id[],
  defaultLabel: (id: Id) => string,
): IntegrationCatalog<Id> {
  return {
    overrides,
    isHidden: (id) => isIntegrationHidden(overrides, id),
    label: (id) => integrationLabel(overrides, id, defaultLabel(id)),
    description: (id) => integrationDescription(overrides, id),
    visibleIds: ids.filter((id) => !isIntegrationHidden(overrides, id)),
  };
}
