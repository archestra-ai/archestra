"use client";

import {
  allowedIntegrationIds,
  orderedPopularAgentIds,
  PopularAgentIdSchema,
  withAllowedIntegrationIds,
  withOrderedPopularAgentIds,
} from "@archestra/shared";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
} from "@/components/settings/settings-block";
import { SortableAgentList } from "@/components/settings/sortable-agent-list";
import {
  MultiSelectCombobox,
  type MultiSelectOption,
} from "@/components/ui/multi-select-combobox";
import {
  useOrganization,
  useUpdateIntegrationSettings,
} from "@/lib/organization.query";

/**
 * Which entries of a built-in catalog this deployment offers, as one chip per
 * entry. Removing a chip switches that entry off for everyone: it leaves every
 * relevant picker. Integration catalogs also enforce availability in the API;
 * popular agent templates control suggestions and runtime image choices.
 *
 * The same control on model providers, knowledge connectors and messaging
 * channels, each living on that catalog's own settings page. It replaces the
 * per-page "Page settings" dialogs, which read as page configuration when they
 * were really a deployment-wide policy.
 */
export function IntegrationAvailabilitySection({
  catalogKey,
  catalog,
  title,
  description,
  options,
  placeholder,
  emptyMessage,
  savedMessage,
  id,
  disabled = false,
}: {
  catalogKey:
    | "modelProviderOverrides"
    | "messagingChannelOverrides"
    | "knowledgeConnectorOverrides"
    | "popularAgentOverrides";
  catalog: readonly string[];
  title: ReactNode;
  description?: ReactNode;
  options: MultiSelectOption[];
  placeholder: string;
  emptyMessage: string;
  savedMessage: string;
  id?: string;
  disabled?: boolean;
}) {
  const { data: organization, isLoadingError, refetch } = useOrganization();
  const updateMutation = useUpdateIntegrationSettings(
    savedMessage,
    `Failed to update ${title}`,
  );

  const overrides = organization?.[catalogKey] ?? null;
  const sortable = catalogKey === "popularAgentOverrides";
  const savedAllowed = sortable
    ? orderedPopularAgentIds(
        organization?.popularAgentOverrides ?? null,
        PopularAgentIdSchema.options,
      )
    : allowedIntegrationIds(overrides, catalog);
  const keyFor = sortable ? orderedSelectionKey : selectionKey;

  const [allowed, setAllowed] = useState<string[]>(savedAllowed);
  // The organization arrives after first paint, and a save replaces it. Both
  // are the same event as far as this section is concerned: adopt what the
  // server now holds, unless the admin has unsaved edits in front of them.
  const savedKey = keyFor(savedAllowed);
  const lastSavedKey = useRef(savedKey);
  useEffect(() => {
    if (lastSavedKey.current === savedKey) return;
    const previousSavedKey = lastSavedKey.current;
    lastSavedKey.current = savedKey;
    setAllowed((current) =>
      keyFor(current) === previousSavedKey ? savedAllowed : current,
    );
  }, [savedKey, savedAllowed, keyFor]);

  const hasChanges = keyFor(allowed) !== savedKey;

  const handleSave = async () => {
    if (!organization || disabled) return;
    await updateMutation.mutateAsync({
      [catalogKey]: sortable
        ? withOrderedPopularAgentIds(
            organization.popularAgentOverrides,
            PopularAgentIdSchema.options,
            allowed,
          )
        : withAllowedIntegrationIds(overrides, catalog, allowed),
    });
  };

  return (
    <>
      <SettingsBlock
        id={id}
        title={title}
        description={description}
        control={null}
      >
        {isLoadingError ? (
          <QueryLoadError
            title="Could not load available options"
            onRetry={() => refetch()}
          />
        ) : (
          <WithPermissions
            permissions={{ organizationSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) =>
              sortable ? (
                <SortableAgentList
                  items={orderedOptions(options, allowed)}
                  shownItemIds={allowed}
                  onShownItemIdsChange={setAllowed}
                  onOrderChange={setAllowed}
                  label="Coding agents"
                  emptyMessage="No coding agents added."
                  inlineAdd
                  disabled={
                    disabled ||
                    !organization ||
                    updateMutation.isPending ||
                    !hasPermission
                  }
                />
              ) : (
                <MultiSelectCombobox
                  options={options}
                  value={allowed}
                  onChange={setAllowed}
                  placeholder={placeholder}
                  emptyMessage={emptyMessage}
                  disabled={
                    disabled ||
                    !organization ||
                    updateMutation.isPending ||
                    !hasPermission
                  }
                />
              )
            }
          </WithPermissions>
        )}
      </SettingsBlock>
      <SettingsSaveBar
        hasChanges={hasChanges}
        isSaving={updateMutation.isPending}
        disabledSave={disabled || !organization}
        permissions={{ organizationSettings: ["update"] }}
        onSave={handleSave}
        onCancel={() => setAllowed(savedAllowed)}
      />
    </>
  );
}

function selectionKey(ids: readonly string[]): string {
  return [...ids].sort().join(",");
}

function orderedOptions(options: MultiSelectOption[], allowed: string[]) {
  return [...options]
    .sort((a, b) => {
      const aIndex = allowed.indexOf(a.value);
      const bIndex = allowed.indexOf(b.value);
      return (
        (aIndex < 0 ? options.length : aIndex) -
        (bIndex < 0 ? options.length : bIndex)
      );
    })
    .map((option) => ({
      id: option.value,
      label: option.label,
      icon: option.icon,
    }));
}

function orderedSelectionKey(ids: readonly string[]): string {
  return ids.join(",");
}
