"use client";

import { useEffect, useState } from "react";
import { LoadingSpinner } from "@/components/loading";
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
  useUpdateMcpSettings,
} from "@/lib/organization.query";

const CATALOG_OPTION_LABELS = {
  enabled: "Enabled",
  disabled: "Disabled",
} as const;

export default function McpSettingsPage() {
  const { data: organization, isPending } = useOrganization();
  const updateMcpSettingsMutation = useUpdateMcpSettings(
    "MCP settings updated",
    "Failed to update MCP settings",
  );

  const serverCatalogEnabled = organization?.onlineMcpCatalogEnabled ?? true;
  const [catalogEnabled, setCatalogEnabled] = useState(serverCatalogEnabled);

  useEffect(() => {
    if (organization) setCatalogEnabled(organization.onlineMcpCatalogEnabled);
  }, [organization]);

  const hasChanges = !isPending && catalogEnabled !== serverCatalogEnabled;

  const handleSave = async () => {
    if (!hasChanges) return;
    await updateMcpSettingsMutation.mutateAsync({
      onlineMcpCatalogEnabled: catalogEnabled,
    });
  };

  const handleCancel = () => setCatalogEnabled(serverCatalogEnabled);

  if (isPending) {
    return <LoadingSpinner className="my-8" />;
  }

  return (
    <SettingsSectionStack>
      <SettingsBlock
        title="Online MCP catalog"
        description="Let people add MCP servers from the public online catalog. When disabled, new servers are always configured manually."
        control={
          <WithPermissions
            permissions={{ mcpSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <Select
                value={catalogEnabled ? "enabled" : "disabled"}
                onValueChange={(value) =>
                  setCatalogEnabled(value === "enabled")
                }
                disabled={updateMcpSettingsMutation.isPending || !hasPermission}
              >
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(CATALOG_OPTION_LABELS).map(
                    ([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            )}
          </WithPermissions>
        }
      />
      <SettingsSaveBar
        hasChanges={hasChanges}
        isSaving={updateMcpSettingsMutation.isPending}
        permissions={{ mcpSettings: ["update"] }}
        onSave={handleSave}
        onCancel={handleCancel}
      />
    </SettingsSectionStack>
  );
}
