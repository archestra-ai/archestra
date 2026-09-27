"use client";

import {
  allowedIntegrationIds,
  withAllowedIntegrationIds,
} from "@archestra/shared";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
} from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  MultiSelectCombobox,
  type MultiSelectOption,
} from "@/components/ui/multi-select-combobox";
import {
  useOrganization,
  useUpdateIntegrationSettings,
} from "@/lib/organization.query";
import { cn } from "@/lib/utils/tailwind";

/**
 * Which entries of a built-in catalog this deployment offers, as one chip per
 * entry. Removing a chip switches that entry off for everyone: it leaves every
 * picker, and the API refuses to configure it.
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
  collapsible = false,
}: {
  catalogKey:
    | "modelProviderOverrides"
    | "messagingChannelOverrides"
    | "knowledgeConnectorOverrides";
  catalog: readonly string[];
  title: ReactNode;
  description?: ReactNode;
  options: MultiSelectOption[];
  placeholder: string;
  emptyMessage: string;
  savedMessage: string;
  id?: string;
  collapsible?: boolean;
}) {
  const { data: organization } = useOrganization();
  const updateMutation = useUpdateIntegrationSettings(
    savedMessage,
    `Failed to update ${title}`,
  );

  const overrides = organization?.[catalogKey] ?? null;
  const savedAllowed = allowedIntegrationIds(overrides, catalog);

  const [allowed, setAllowed] = useState<string[]>(savedAllowed);
  const [isOpen, setIsOpen] = useState(false);
  // The organization arrives after first paint, and a save replaces it. Both
  // are the same event as far as this section is concerned: adopt what the
  // server now holds, unless the admin has unsaved edits in front of them.
  const savedKey = savedAllowed.join(",");
  const lastSavedKey = useRef(savedKey);
  useEffect(() => {
    if (lastSavedKey.current === savedKey) return;
    lastSavedKey.current = savedKey;
    setAllowed(savedAllowed);
  }, [savedKey, savedAllowed]);

  const hasChanges = allowed.join(",") !== savedKey;

  const handleSave = async () => {
    await updateMutation.mutateAsync({
      [catalogKey]: withAllowedIntegrationIds(overrides, catalog, allowed),
    });
  };

  const selector = (
    <WithPermissions
      permissions={{ organizationSettings: ["update"] }}
      noPermissionHandle="tooltip"
    >
      {({ hasPermission }) => (
        <MultiSelectCombobox
          options={options}
          value={allowed}
          onChange={setAllowed}
          placeholder={placeholder}
          emptyMessage={emptyMessage}
          disabled={updateMutation.isPending || !hasPermission}
        />
      )}
    </WithPermissions>
  );

  return (
    <>
      <SettingsBlock
        id={id}
        title={title}
        description={description}
        control={null}
      >
        {collapsible ? (
          <Collapsible open={isOpen} onOpenChange={setIsOpen}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-10 w-full justify-between py-2 font-normal"
              >
                <span>
                  {allowed.length} of {catalog.length} types enabled
                </span>
                <ChevronDown
                  className={cn(
                    "size-4 text-muted-foreground transition-transform",
                    isOpen && "rotate-180",
                  )}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">{selector}</CollapsibleContent>
          </Collapsible>
        ) : (
          selector
        )}
      </SettingsBlock>
      <SettingsSaveBar
        hasChanges={hasChanges}
        isSaving={updateMutation.isPending}
        permissions={{ organizationSettings: ["update"] }}
        onSave={handleSave}
        onCancel={() => setAllowed(savedAllowed)}
      />
    </>
  );
}
