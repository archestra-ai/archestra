"use client";

import {
  builtInProviderLabel,
  MAX_INTEGRATION_DISPLAY_NAME_LENGTH,
  type ModelProviderOverrides,
  pruneIntegrationOverrides,
  type SupportedProvider,
  SupportedProviders,
} from "@archestra/shared";
import { useEffect, useRef, useState } from "react";
import {
  CollectionFilters,
  FilterBar,
  filterSearchClass,
} from "@/components/filter-bar";
import { ProviderIcon } from "@/components/provider-icon";
import { WithPermissions } from "@/components/roles/with-permissions";
import { SearchInput } from "@/components/search-input";
import {
  SettingsBlock,
  SettingsSaveBar,
} from "@/components/settings/settings-block";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  useOrganization,
  useUpdateIntegrationSettings,
} from "@/lib/organization.query";
import { providerSearchHaystack } from "@/lib/provider-search";

/**
 * Which model providers this deployment offers, and what it calls them.
 *
 * Availability and the name live on one row per provider because they are the
 * same decision made twice: a provider you offer usually needs the name your
 * organization knows it by. Splitting them into a chip list and a separate
 * list of name fields made the reader match provider to row across two
 * controls.
 *
 * A provider switched off leaves every picker, and the API refuses to
 * configure it. Keys that already exist keep working.
 */
export function ModelProvidersSection() {
  const { data: organization } = useOrganization();
  const updateMutation = useUpdateIntegrationSettings(
    "Model providers updated",
    "Failed to update model providers",
  );

  const overrides = organization?.modelProviderOverrides ?? null;
  const savedDraft = toDraft(overrides);
  const savedKey = JSON.stringify(savedDraft);

  const [draft, setDraft] = useState(savedDraft);
  const [search, setSearch] = useState("");

  // Adopt what the server holds once the organization arrives, and again after
  // a save replaces it.
  const lastSavedKey = useRef(savedKey);
  useEffect(() => {
    if (lastSavedKey.current === savedKey) return;
    lastSavedKey.current = savedKey;
    setDraft(savedDraft);
  }, [savedKey, savedDraft]);

  const hasChanges = JSON.stringify(draft) !== savedKey;

  // Matches the organization's own name too, so a renamed provider is findable
  // by the name people here actually know it by, and the entry's aliases, so a
  // generic entry is findable by the products it serves.
  const query = search.trim().toLowerCase();
  const visible = SupportedProviders.filter((provider) =>
    providerSearchHaystack({
      provider,
      labels: [builtInProviderLabel(provider), draft[provider]?.displayName],
    })
      .toLowerCase()
      .includes(query),
  );

  const patch = (provider: SupportedProvider, changes: Partial<DraftEntry>) =>
    setDraft((prev) => ({
      ...prev,
      [provider]: { ...prev[provider], ...changes },
    }));

  const handleSave = async () => {
    const next: ModelProviderOverrides = {};
    for (const provider of SupportedProviders) {
      const entry = draft[provider];
      next[provider] = {
        hidden: entry.hidden,
        displayName: entry.displayName.trim() || null,
      };
    }
    await updateMutation.mutateAsync({
      modelProviderOverrides: pruneIntegrationOverrides(next),
    });
  };

  return (
    <>
      <SettingsBlock
        id="model-providers"
        title="Model providers"
        description="Which providers this deployment offers, and the name it shows them under. A provider you switch off leaves every picker, and the API refuses to configure it — keys that already exist keep working."
        control={null}
      >
        <WithPermissions
          permissions={{ organizationSettings: ["update"] }}
          noPermissionHandle="tooltip"
        >
          {({ hasPermission }) => {
            const locked = updateMutation.isPending || !hasPermission;
            return (
              <div>
                <CollectionFilters>
                  <FilterBar
                    onClearFilters={search ? () => setSearch("") : undefined}
                  >
                    <SearchInput
                      value={search}
                      onSearchChange={setSearch}
                      syncQueryParams={false}
                      placeholder="Search providers…"
                      className={filterSearchClass}
                    />
                  </FilterBar>
                </CollectionFilters>

                {visible.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    No providers match “{search}”.
                  </p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {visible.map((provider) => {
                      const entry = draft[provider] ?? EMPTY_DRAFT_ENTRY;
                      const label = builtInProviderLabel(provider);
                      return (
                        <div
                          key={provider}
                          data-testid={`model-provider-row-${provider}`}
                          data-hidden={entry.hidden}
                          className="rounded-lg border bg-card/40 p-3 transition-colors data-[hidden=true]:opacity-60"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex min-w-0 items-center gap-2">
                              <ProviderIcon provider={provider} size={18} />
                              <span className="truncate text-sm font-medium">
                                {label}
                              </span>
                            </div>
                            <Label
                              htmlFor={`model-provider-available-${provider}`}
                              className="flex shrink-0 items-center gap-2 text-[11.5px] font-medium text-muted-foreground"
                            >
                              <Switch
                                id={`model-provider-available-${provider}`}
                                checked={!entry.hidden}
                                onCheckedChange={(checked) =>
                                  patch(provider, { hidden: !checked })
                                }
                                disabled={locked}
                                aria-label={`Make ${label} available`}
                              />
                              <span>Available</span>
                            </Label>
                          </div>
                          <Input
                            aria-label={`${label} display name`}
                            value={entry.displayName}
                            onChange={(event) =>
                              patch(provider, {
                                displayName: event.target.value,
                              })
                            }
                            placeholder={`Show as “${label}”`}
                            maxLength={MAX_INTEGRATION_DISPLAY_NAME_LENGTH}
                            disabled={locked}
                            className="mt-2 text-sm"
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }}
        </WithPermissions>
      </SettingsBlock>
      <SettingsSaveBar
        hasChanges={hasChanges}
        isSaving={updateMutation.isPending}
        permissions={{ organizationSettings: ["update"] }}
        onSave={handleSave}
        onCancel={() => setDraft(savedDraft)}
      />
    </>
  );
}

/** The name input is controlled, so the draft holds "" rather than null. */
type DraftEntry = { hidden: boolean; displayName: string };

const EMPTY_DRAFT_ENTRY: DraftEntry = { hidden: false, displayName: "" };

function toDraft(
  overrides: ModelProviderOverrides | null,
): Record<SupportedProvider, DraftEntry> {
  const draft = {} as Record<SupportedProvider, DraftEntry>;
  for (const provider of SupportedProviders) {
    const override = overrides?.[provider];
    draft[provider] = {
      hidden: override?.hidden === true,
      displayName: override?.displayName ?? "",
    };
  }
  return draft;
}
