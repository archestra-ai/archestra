"use client";

import {
  builtInProviderLabel,
  MAX_INTEGRATION_DISPLAY_NAME_LENGTH,
  type ModelProviderOverride,
  pruneIntegrationOverrides,
  type SupportedProvider,
  SupportedProviders,
} from "@archestra/shared";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { ProviderIcon } from "@/components/provider-icon";
import {
  SettingsBlock,
  SettingsSaveBar,
} from "@/components/settings/settings-block";
import { Input } from "@/components/ui/input";
import {
  useOrganization,
  useUpdateIntegrationSettings,
} from "@/lib/organization.query";

/**
 * The organization's own names for the built-in model providers.
 *
 * Deliberately org-wide rather than per-role: which providers a role may
 * *use* is an access question and lives on the role, but a provider that reads
 * under two names to two people makes every setup instruction and support
 * conversation ambiguous.
 */
export function ProviderNamesSection() {
  const { data: organization } = useOrganization();
  const overrides = organization?.modelProviderOverrides ?? null;
  const serverNames = useMemo(() => toNames(overrides), [overrides]);
  const [names, setNames] = useState<Record<string, string>>(serverNames);
  const [syncedFrom, setSyncedFrom] = useState(serverNames);
  const [search, setSearch] = useState("");

  // Adopt a fresh server value whenever it changes underneath us, without
  // clobbering edits in progress.
  if (syncedFrom !== serverNames) {
    setSyncedFrom(serverNames);
    setNames(serverNames);
  }

  const updateMutation = useUpdateIntegrationSettings(
    "Provider names updated",
    "Failed to update provider names",
  );

  const hasChanges = JSON.stringify(names) !== JSON.stringify(serverNames);

  const query = search.trim().toLowerCase();
  const visibleProviders = SupportedProviders.filter((provider) =>
    `${builtInProviderLabel(provider)} ${names[provider] ?? ""}`
      .toLowerCase()
      .includes(query),
  );

  const handleSave = () => {
    const next: Partial<Record<SupportedProvider, ModelProviderOverride>> = {};
    for (const provider of SupportedProviders) {
      next[provider] = { displayName: names[provider] ?? "" };
    }
    updateMutation.mutate({
      modelProviderOverrides: pruneIntegrationOverrides(next),
    });
  };

  return (
    <>
      <SettingsBlock
        title="Provider names"
        description="Rename a built-in model provider for your organization. The name replaces the built-in one everywhere it is rendered. Leave a field blank to keep the shipped name."
        control={
          <div className="relative w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search providers…"
              aria-label="Search providers"
              className="pl-8 text-sm"
            />
          </div>
        }
      >
        {visibleProviders.length === 0 ? (
          <p className="py-2 text-center text-sm text-muted-foreground">
            No providers match “{search}”.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {visibleProviders.map((provider) => (
              <div
                key={provider}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-3"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <ProviderIcon provider={provider} size={18} />
                  <span className="truncate text-sm">
                    {builtInProviderLabel(provider)}
                  </span>
                </div>
                <Input
                  aria-label={`${builtInProviderLabel(provider)} display name`}
                  value={names[provider] ?? ""}
                  onChange={(e) =>
                    setNames((prev) => ({
                      ...prev,
                      [provider]: e.target.value,
                    }))
                  }
                  placeholder={`Show as “${builtInProviderLabel(provider)}”`}
                  maxLength={MAX_INTEGRATION_DISPLAY_NAME_LENGTH}
                  className="text-sm"
                />
              </div>
            ))}
          </div>
        )}
      </SettingsBlock>
      <SettingsSaveBar
        hasChanges={hasChanges}
        isSaving={updateMutation.isPending}
        permissions={{ organizationSettings: ["update"] }}
        onSave={handleSave}
        onCancel={() => setNames(serverNames)}
      />
    </>
  );
}

// ===================================================================
// Internal
// ===================================================================

function toNames(
  overrides: Partial<Record<SupportedProvider, ModelProviderOverride>> | null,
): Record<string, string> {
  const names: Record<string, string> = {};
  for (const provider of SupportedProviders) {
    names[provider] = overrides?.[provider]?.displayName ?? "";
  }
  return names;
}
