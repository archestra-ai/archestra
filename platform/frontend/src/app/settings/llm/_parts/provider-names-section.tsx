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
import { ProviderIcon } from "@/components/provider-icon";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
} from "@/components/settings/settings-block";
import { Input } from "@/components/ui/input";
import {
  useOrganization,
  useUpdateIntegrationSettings,
} from "@/lib/organization.query";

type ProviderNames = Partial<Record<SupportedProvider, string>>;

/**
 * The organization's own name for a built-in model provider. It replaces the
 * shipped one everywhere the provider is rendered — pickers, tables, and the
 * setup copy on the connect page.
 *
 * Deliberately one name per deployment rather than per team or per role: a
 * provider that reads under two names to two people makes every setup
 * instruction and support conversation ambiguous.
 */
export function ProviderNamesSection() {
  const { data: organization } = useOrganization();
  const updateMutation = useUpdateIntegrationSettings(
    "Provider names updated",
    "Failed to update provider names",
  );

  const overrides = organization?.modelProviderOverrides ?? null;
  const savedNames = toNames(overrides);
  const savedKey = JSON.stringify(savedNames);

  const [names, setNames] = useState<ProviderNames>(savedNames);
  const lastSavedKey = useRef(savedKey);
  useEffect(() => {
    if (lastSavedKey.current === savedKey) return;
    lastSavedKey.current = savedKey;
    setNames(savedNames);
  }, [savedKey, savedNames]);

  const hasChanges = JSON.stringify(names) !== savedKey;

  const handleSave = async () => {
    const next: ModelProviderOverrides = {};
    for (const provider of SupportedProviders) {
      next[provider] = {
        ...(overrides?.[provider] ?? {}),
        displayName: names[provider]?.trim() || null,
      };
    }
    await updateMutation.mutateAsync({
      modelProviderOverrides: pruneIntegrationOverrides(next),
    });
  };

  return (
    <>
      <SettingsBlock
        id="provider-names"
        title="Provider names"
        description="Rename a built-in model provider for your organization. Leave a field blank to keep the name it ships with."
        control={null}
      >
        <WithPermissions
          permissions={{ organizationSettings: ["update"] }}
          noPermissionHandle="tooltip"
        >
          {({ hasPermission }) => (
            <div className="grid gap-3 sm:grid-cols-2">
              {SupportedProviders.map((provider) => (
                <div key={provider} className="flex items-center gap-3">
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <ProviderIcon provider={provider} size={18} />
                    <span className="truncate text-sm">
                      {builtInProviderLabel(provider)}
                    </span>
                  </span>
                  <Input
                    value={names[provider] ?? ""}
                    onChange={(event) =>
                      setNames((current) => ({
                        ...current,
                        [provider]: event.target.value,
                      }))
                    }
                    placeholder={`Show as “${builtInProviderLabel(provider)}”`}
                    maxLength={MAX_INTEGRATION_DISPLAY_NAME_LENGTH}
                    disabled={updateMutation.isPending || !hasPermission}
                    className="max-w-[16rem] flex-1"
                  />
                </div>
              ))}
            </div>
          )}
        </WithPermissions>
      </SettingsBlock>
      <SettingsSaveBar
        hasChanges={hasChanges}
        isSaving={updateMutation.isPending}
        permissions={{ organizationSettings: ["update"] }}
        onSave={handleSave}
        onCancel={() => setNames(savedNames)}
      />
    </>
  );
}

function toNames(overrides: ModelProviderOverrides | null): ProviderNames {
  const names: ProviderNames = {};
  for (const provider of SupportedProviders) {
    const stored = overrides?.[provider]?.displayName?.trim();
    if (stored) names[provider] = stored;
  }
  return names;
}
