"use client";

import type { LogContentMode } from "@archestra/shared";
import { useEffect, useState } from "react";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useOrganization,
  useUpdateLogsSettings,
} from "@/lib/organization.query";

const LOG_CONTENT_LABELS: Record<LogContentMode, string> = {
  full: "Full content",
  metadata_only: "Metadata only",
};

export default function LogsSettingsPage() {
  const { data: organization, isPending } = useOrganization();
  const updateLogsSettingsMutation = useUpdateLogsSettings(
    "Logs settings updated",
    "Failed to update Logs settings",
  );

  const serverMode = organization?.logContentMode ?? "full";
  const [mode, setMode] = useState<LogContentMode>(serverMode);

  useEffect(() => {
    if (!organization) return;
    setMode(organization.logContentMode);
  }, [organization]);

  const hasChanges = !isPending && mode !== serverMode;

  const handleSave = async () => {
    if (!hasChanges) return;
    await updateLogsSettingsMutation.mutateAsync({ logContentMode: mode });
  };

  if (isPending) {
    return null;
  }

  return (
    <SettingsSectionStack>
      <SettingsBlock
        title="Log Content"
        description="What the LLM Logs, MCP Logs, and Guardrail consults pages store for each request. With Metadata only, prompts, responses, tool arguments, tool results, and error messages are never written. Who made the request, when, which model or tool ran, token usage, cost, and whether it succeeded are still recorded, so usage statistics and cost limits keep working."
        notice={
          <span className="text-muted-foreground">
            Applies to new requests only: logs already stored are not changed.
            Chat history is stored separately and is not affected.
          </span>
        }
        control={
          <WithPermissions
            permissions={{ organizationSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <Select
                value={mode}
                onValueChange={(value) => setMode(value as LogContentMode)}
                disabled={
                  updateLogsSettingsMutation.isPending || !hasPermission
                }
              >
                <SelectTrigger className="w-48" aria-label="Log Content">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(LOG_CONTENT_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </WithPermissions>
        }
      />
      <SettingsSaveBar
        hasChanges={hasChanges}
        isSaving={updateLogsSettingsMutation.isPending}
        permissions={{ organizationSettings: ["update"] }}
        onSave={handleSave}
        onCancel={() => setMode(serverMode)}
      />
    </SettingsSectionStack>
  );
}
