"use client";

import type { Permissions } from "@archestra/shared";
import { useEffect, useState } from "react";
import { DisabledEnterpriseSection } from "@/components/disabled-enterprise-section";
import { LoadingSpinner } from "@/components/loading";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { SmallTeamTierBanner } from "@/components/small-team-tier-banner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEnterpriseFeature, useFeature } from "@/lib/config/config.query";
import {
  useOrganization,
  useUpdateMcpSettings,
} from "@/lib/organization.query";

const TOGGLE_OPTION_LABELS = {
  enabled: "Enabled",
  disabled: "Disabled",
} as const;

const MCP_SETTINGS_PERMISSIONS: Permissions = { mcpSettings: ["update"] };

export default function McpSettingsPage() {
  const { data: organization, isPending } = useOrganization();
  const enterpriseCoreActive = useEnterpriseFeature("core");
  // Idle hibernation ships as a beta feature: with the deployment flag off,
  // the setting does not exist on this page at all.
  const hibernationBeta = useFeature("mcpIdleHibernationBetaEnabled");
  const updateMcpSettingsMutation = useUpdateMcpSettings(
    "MCP settings updated",
    "Failed to update MCP settings",
  );

  const serverCatalogEnabled = organization?.onlineMcpCatalogEnabled ?? true;
  const serverHibernationEnabled =
    organization?.mcpIdleHibernationEnabled ?? false;
  const [catalogEnabled, setCatalogEnabled] = useState(serverCatalogEnabled);
  const [hibernationEnabled, setHibernationEnabled] = useState(
    serverHibernationEnabled,
  );

  useEffect(() => {
    if (organization) {
      setCatalogEnabled(organization.onlineMcpCatalogEnabled);
      setHibernationEnabled(organization.mcpIdleHibernationEnabled);
    }
  }, [organization]);

  const catalogChanged = !isPending && catalogEnabled !== serverCatalogEnabled;
  const hibernationChanged =
    !isPending && hibernationEnabled !== serverHibernationEnabled;
  const hasChanges = catalogChanged || hibernationChanged;

  const handleSave = async () => {
    if (!hasChanges) return;
    // Only the fields the user actually moved go in the payload, so saving the
    // catalog setting never re-asserts an enterprise-gated one the caller may
    // not be allowed to set.
    await updateMcpSettingsMutation.mutateAsync({
      ...(catalogChanged ? { onlineMcpCatalogEnabled: catalogEnabled } : {}),
      ...(hibernationChanged
        ? { mcpIdleHibernationEnabled: hibernationEnabled }
        : {}),
    });
  };

  const handleCancel = () => {
    setCatalogEnabled(serverCatalogEnabled);
    setHibernationEnabled(serverHibernationEnabled);
  };

  if (isPending) {
    return <LoadingSpinner className="my-8" />;
  }

  return (
    <>
      {hibernationBeta && (
        <SmallTeamTierBanner featureName="Idle hibernation" />
      )}
      <SettingsSectionStack>
        <SettingsBlock
          title="Online MCP catalog"
          description="Let people add MCP servers from the public online catalog. When disabled, new servers are always configured manually."
          control={
            <ToggleControl
              value={catalogEnabled}
              onChange={setCatalogEnabled}
              isSaving={updateMcpSettingsMutation.isPending}
            />
          }
        />
        {/* Only this block is enterprise (and beta) — the catalog setting
            above stays available to every deployment. */}
        {hibernationBeta && (
          <DisabledEnterpriseSection disabled={!enterpriseCoreActive}>
            <SettingsBlock
              title="Idle hibernation"
              description="Hibernates self-hosted MCP servers that go unused, scaling them to zero until the next tool call. Beta feature."
              control={
                <ToggleControl
                  value={hibernationEnabled}
                  onChange={setHibernationEnabled}
                  isSaving={updateMcpSettingsMutation.isPending}
                />
              }
            />
          </DisabledEnterpriseSection>
        )}
        <SettingsSaveBar
          hasChanges={hasChanges}
          isSaving={updateMcpSettingsMutation.isPending}
          permissions={MCP_SETTINGS_PERMISSIONS}
          onSave={handleSave}
          onCancel={handleCancel}
        />
      </SettingsSectionStack>
    </>
  );
}

/** Enabled/disabled select shared by every block on this page. */
function ToggleControl({
  value,
  onChange,
  isSaving,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  isSaving: boolean;
}) {
  return (
    <WithPermissions
      permissions={MCP_SETTINGS_PERMISSIONS}
      noPermissionHandle="tooltip"
    >
      {({ hasPermission }) => (
        <Select
          value={value ? "enabled" : "disabled"}
          onValueChange={(next) => onChange(next === "enabled")}
          disabled={isSaving || !hasPermission}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(TOGGLE_OPTION_LABELS).map(
              ([optionValue, label]) => (
                <SelectItem key={optionValue} value={optionValue}>
                  {label}
                </SelectItem>
              ),
            )}
          </SelectContent>
        </Select>
      )}
    </WithPermissions>
  );
}
