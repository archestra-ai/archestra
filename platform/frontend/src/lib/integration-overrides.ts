"use client";

import {
  builtInProviderLabel,
  CONNECTOR_TYPE_LABELS,
  type ConnectorType,
  type IntegrationToggle,
  integrationLabel,
  isIntegrationHidden,
  MESSAGING_CHANNEL_LABELS,
  type MessagingChannelId,
  type ModelProviderOverride,
  type SupportedProvider,
  SupportedProviders,
} from "@archestra/shared";
import { useMemo } from "react";
import { useOrganization } from "@/lib/organization.query";

/**
 * Which entries of a built-in catalog the admins left switched on.
 *
 * Messaging channels and knowledge connectors are toggle-only: each names one
 * external service, so renaming them would only make the setup instructions
 * harder to follow. Model providers additionally carry a name — see
 * {@link useModelProviderCatalog}.
 */
export type IntegrationCatalog<Id extends string> = {
  overrides: Partial<Record<Id, IntegrationToggle>> | null;
  /** Entries the admin switched off — never offer these anywhere. */
  isHidden: (id: Id) => boolean;
  /** Every catalog id the admin left switched on, in catalog order. */
  visibleIds: Id[];
};

/** A catalog whose entries the organization can also rename. */
export type NamedIntegrationCatalog<Id extends string> =
  IntegrationCatalog<Id> & {
    overrides: Partial<Record<Id, ModelProviderOverride>> | null;
    /** The organization's name for an entry, or the built-in one. */
    label: (id: Id) => string;
  };

/**
 * Read the organization the way availability decisions need it: revalidated on
 * mount and whenever the tab regains focus.
 *
 * The plain read caches for five minutes and is kept current by mutations
 * writing the key imperatively — enough for the app name and theme, wrong for
 * a catalog. That write only lands in the tab that saved, and the query is
 * restored from the refresh snapshot, so a tab that was already open (or
 * merely reloaded within the window) went on offering a provider the admins
 * had just switched off. Availability authorizes what may be configured, so it
 * is read on the same terms as the connect page's settings.
 */
function useIntegrationOrganization() {
  return useOrganization(true, { fresh: true });
}

export function useModelProviderCatalog(): NamedIntegrationCatalog<SupportedProvider> {
  const { data: organization } = useIntegrationOrganization();
  const overrides = organization?.modelProviderOverrides ?? null;
  return useMemo(
    () => ({
      ...buildCatalog(overrides, SupportedProviders),
      overrides,
      label: (id: SupportedProvider) =>
        integrationLabel(overrides, id, builtInProviderLabel(id)),
    }),
    [overrides],
  );
}

export function useMessagingChannelCatalog(): IntegrationCatalog<MessagingChannelId> {
  const { data: organization } = useIntegrationOrganization();
  const overrides = organization?.messagingChannelOverrides ?? null;
  return useMemo(
    () =>
      buildCatalog(
        overrides,
        Object.keys(MESSAGING_CHANNEL_LABELS) as MessagingChannelId[],
      ),
    [overrides],
  );
}

export function useKnowledgeConnectorCatalog(): IntegrationCatalog<ConnectorType> {
  const { data: organization } = useIntegrationOrganization();
  const overrides = organization?.knowledgeConnectorOverrides ?? null;
  return useMemo(
    () =>
      buildCatalog(
        overrides,
        Object.keys(CONNECTOR_TYPE_LABELS) as ConnectorType[],
      ),
    [overrides],
  );
}

// ===================================================================
// Internal
// ===================================================================

function buildCatalog<Id extends string>(
  overrides: Partial<Record<Id, IntegrationToggle>> | null,
  ids: readonly Id[],
): IntegrationCatalog<Id> {
  return {
    overrides,
    isHidden: (id) => isIntegrationHidden(overrides, id),
    visibleIds: ids.filter((id) => !isIntegrationHidden(overrides, id)),
  };
}
