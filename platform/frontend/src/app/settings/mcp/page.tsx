"use client";

import type { Permissions } from "@archestra/shared";
import { useEffect, useState } from "react";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { DisabledEnterpriseSection } from "@/components/disabled-enterprise-section";
// SPDX-SnippetEnd
import { LoadingState } from "@/components/loading";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { SmallTeamTierBanner } from "@/components/small-team-tier-banner";
// SPDX-SnippetEnd
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { useEnterpriseFeature, useFeature } from "@/lib/config/config.query";
// SPDX-SnippetEnd
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
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  const enterpriseCoreActive = useEnterpriseFeature("core");
  // Idle hibernation ships as a beta feature: with the deployment flag off,
  // the setting does not exist on this page at all.
  const hibernationBeta = useFeature("mcpIdleHibernationBetaEnabled");
  // SPDX-SnippetEnd
  const updateMcpSettingsMutation = useUpdateMcpSettings(
    "MCP settings updated",
    "Failed to update MCP settings",
  );

  const serverCatalogEnabled = organization?.onlineMcpCatalogEnabled ?? true;
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  const serverHibernationEnabled =
    organization?.mcpIdleHibernationEnabled ?? false;
  // SPDX-SnippetEnd
  const [catalogEnabled, setCatalogEnabled] = useState(serverCatalogEnabled);
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  const [hibernationEnabled, setHibernationEnabled] = useState(
    serverHibernationEnabled,
  );
  // SPDX-SnippetEnd

  useEffect(() => {
    if (organization) {
      setCatalogEnabled(organization.onlineMcpCatalogEnabled);
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      setHibernationEnabled(organization.mcpIdleHibernationEnabled);
      // SPDX-SnippetEnd
    }
  }, [organization]);

  const catalogChanged = !isPending && catalogEnabled !== serverCatalogEnabled;
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  const hibernationChanged =
    !isPending && hibernationEnabled !== serverHibernationEnabled;
  // SPDX-SnippetEnd
  const hasChanges =
    catalogChanged /* SPDX-SnippetBegin */ ||
    /* SPDX-SnippetCopyrightText: 2026 Archestra Inc. */
    /* SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */ hibernationChanged /* SPDX-SnippetEnd */;

  const handleSave = async () => {
    if (!hasChanges) return;
    // Only the fields the user actually moved go in the payload, so saving the
    // catalog setting never re-asserts an enterprise-gated one the caller may
    // not be allowed to set.
    await updateMcpSettingsMutation.mutateAsync({
      ...(catalogChanged ? { onlineMcpCatalogEnabled: catalogEnabled } : {}),
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      ...(hibernationChanged
        ? { mcpIdleHibernationEnabled: hibernationEnabled }
        : {}),
      // SPDX-SnippetEnd
    });
  };

  const handleCancel = () => {
    setCatalogEnabled(serverCatalogEnabled);
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    setHibernationEnabled(serverHibernationEnabled);
    // SPDX-SnippetEnd
  };

  if (isPending) {
    return <LoadingState variant="page" />;
  }

  return (
    <>
      {/* SPDX-SnippetBegin */}
      {/* SPDX-SnippetCopyrightText: 2026 Archestra Inc. */}
      {/* SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */}
      {hibernationBeta && (
        <SmallTeamTierBanner featureName="Idle hibernation" />
      )}
      {/* SPDX-SnippetEnd */}
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
        {/* SPDX-SnippetBegin */}
        {/* SPDX-SnippetCopyrightText: 2026 Archestra Inc. */}
        {/* SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */}
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
        {/* SPDX-SnippetEnd */}
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
