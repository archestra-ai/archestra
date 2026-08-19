"use client";

import {
  allowedFromCatalog,
  builtInProviderLabel,
  CONNECTOR_TYPE_LABELS,
  type ConnectorType,
  collapseAllowList,
  integrationLabel,
  MESSAGING_CHANNEL_LABELS,
  type MessagingChannelId,
  ROLE_RESOURCE_KIND_LABELS,
  type RoleResourceAccess,
  type RoleResourceKind,
  type SupportedProvider,
  SupportedProviders,
} from "@archestra/shared";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { ClientIcon } from "@/app/connection/client-icon";
import { CONNECT_CLIENTS } from "@/app/connection/clients";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { CHANNEL_OPTIONS } from "@/app/messaging-channels/_components/channel-icons";
import { ProviderIcon } from "@/components/provider-icon";
import { Card } from "@/components/ui/card";
import {
  MultiSelectCombobox,
  type MultiSelectOption,
} from "@/components/ui/multi-select-combobox";
import { useOrganization } from "@/lib/organization.query";

/**
 * One chip multiselect per gated catalog, for the role being edited.
 *
 * Replaces the three per-page "Page settings" modals, which were org-wide
 * allow-lists wearing a per-page label. The chips carry the whole contract: a
 * role shows every entry it may reach, `x` removes one, the search adds one
 * back, and removing the last chip means the role gets none of that catalog.
 *
 * A role with no restriction shows every chip. Editing from that state writes
 * an explicit list, and re-selecting everything collapses back to unrestricted
 * so the role keeps up with catalogs a later release grows.
 */
export function RoleResourceAccessBuilder({
  resourceAccess,
  onChange,
  readOnly = false,
}: {
  resourceAccess: RoleResourceAccess;
  onChange: (access: RoleResourceAccess) => void;
  readOnly?: boolean;
}) {
  // The organization's provider names, not the viewer's catalog: this editor
  // shows the full catalog whatever the admin's own role may reach.
  const { data: organization } = useOrganization();
  const providerOverrides = organization?.modelProviderOverrides ?? null;
  const sections = useMemo(
    () =>
      buildSections((provider) =>
        integrationLabel(
          providerOverrides,
          provider,
          builtInProviderLabel(provider),
        ),
      ),
    [providerOverrides],
  );

  return (
    <Card className="space-y-5 p-4">
      {sections.map((section) => {
        const stored = resourceAccess[section.kind];
        const catalogIds = section.options.map((option) => option.value);
        return (
          <div key={section.kind} data-testid={`role-access-${section.kind}`}>
            <div className="text-sm font-medium text-foreground">
              {ROLE_RESOURCE_KIND_LABELS[section.kind]}
            </div>
            <div className="mb-2 mt-0.5 text-[13px] text-muted-foreground">
              {section.description}
            </div>
            <MultiSelectCombobox
              options={section.options}
              // An unrestricted role owns the whole catalog, so it renders as
              // every chip rather than as an empty box that reads like "none".
              value={allowedFromCatalog(stored, catalogIds)}
              onChange={(selected) =>
                onChange({
                  ...resourceAccess,
                  [section.kind]: collapseAllowList(selected, catalogIds),
                })
              }
              placeholder={section.placeholder}
              emptyMessage={section.emptyMessage}
              disabled={readOnly}
            />
            {stored?.length === 0 && (
              <p className="mt-1.5 text-[12.5px] text-muted-foreground">
                {section.noneAllowed}
              </p>
            )}
          </div>
        );
      })}
    </Card>
  );
}

// ===================================================================
// Internal
// ===================================================================

type Section = {
  kind: RoleResourceKind;
  description: ReactNode;
  placeholder: string;
  emptyMessage: string;
  /** Shown under an empty list, where "no chips" needs saying out loud. */
  noneAllowed: string;
  options: MultiSelectOption[];
};

function buildSections(
  providerLabel: (provider: SupportedProvider) => string,
): Section[] {
  return [
    {
      kind: "modelProviders",
      description:
        "Providers this role can be given credentials for and pick models from.",
      placeholder: "Search providers…",
      emptyMessage: "No providers found.",
      noneAllowed: "This role cannot use any model provider.",
      options: SupportedProviders.map((provider) => ({
        value: provider,
        label: providerLabel(provider),
        icon: <ProviderIcon provider={provider} size={18} />,
      })),
    },
    {
      kind: "knowledgeConnectors",
      description: "Connector types this role can create knowledge sources of.",
      placeholder: "Search connector types…",
      emptyMessage: "No connector types found.",
      noneAllowed: "This role cannot create any connector.",
      options: (Object.keys(CONNECTOR_TYPE_LABELS) as ConnectorType[]).map(
        (type) => ({
          value: type,
          label: CONNECTOR_TYPE_LABELS[type],
          icon: <ConnectorTypeIcon type={type} className="h-[18px] w-[18px]" />,
        }),
      ),
    },
    {
      kind: "messagingChannels",
      description:
        "Channels this role can configure and reach agents through. A channel stops listening once no role includes it.",
      placeholder: "Search channels…",
      emptyMessage: "No channels found.",
      noneAllowed: "This role cannot use any messaging channel.",
      options: CHANNEL_OPTIONS.map((channel) => ({
        value: channel.id,
        label: MESSAGING_CHANNEL_LABELS[channel.id as MessagingChannelId],
        icon: channel.icon,
      })),
    },
    {
      kind: "connectClients",
      description:
        "Clients this role is offered setup instructions for. “Any client” is always available.",
      placeholder: "Search clients…",
      emptyMessage: "No clients found.",
      noneAllowed: "This role is only offered the generic client setup.",
      options: CONNECT_CLIENTS.filter(
        (client) => client.id !== GENERIC_CLIENT_ID,
      ).map((client) => ({
        value: client.id,
        label: client.label,
        icon: <ClientIcon client={client} size={18} />,
      })),
    },
  ];
}

/** "Any client" is the fallback setup; admins cannot take it away. */
const GENERIC_CLIENT_ID = "generic";
