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
  useUpdateSkillsSettings,
} from "@/lib/organization.query";

const CATALOG_OPTION_LABELS = {
  enabled: "Enabled",
  disabled: "Disabled",
} as const;

export default function SkillsSettingsPage() {
  const { data: organization, isPending } = useOrganization();
  const updateSkillsSettingsMutation = useUpdateSkillsSettings(
    "Skills settings updated",
    "Failed to update Skills settings",
  );

  const serverCatalogEnabled = organization?.onlineSkillCatalogEnabled ?? true;
  const [catalogEnabled, setCatalogEnabled] = useState(serverCatalogEnabled);

  useEffect(() => {
    if (organization) setCatalogEnabled(organization.onlineSkillCatalogEnabled);
  }, [organization]);

  const hasChanges = !isPending && catalogEnabled !== serverCatalogEnabled;

  const handleSave = async () => {
    if (!hasChanges) return;
    await updateSkillsSettingsMutation.mutateAsync({
      onlineSkillCatalogEnabled: catalogEnabled,
    });
  };

  const handleCancel = () => setCatalogEnabled(serverCatalogEnabled);

  if (isPending) {
    return <LoadingSpinner className="my-8" />;
  }

  return (
    <SettingsSectionStack>
      <SettingsBlock
        title="Online skill catalog"
        description="Let people discover and import skills from the public online catalog — the popular-repository list, the skill index search, and GitHub-repo imports on the add-skill page. When disabled, the add-skill page opens the blank-template editor directly."
        control={
          <WithPermissions
            permissions={{ skillsSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <Select
                value={catalogEnabled ? "enabled" : "disabled"}
                onValueChange={(value) =>
                  setCatalogEnabled(value === "enabled")
                }
                disabled={
                  updateSkillsSettingsMutation.isPending || !hasPermission
                }
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
        isSaving={updateSkillsSettingsMutation.isPending}
        permissions={{ skillsSettings: ["update"] }}
        onSave={handleSave}
        onCancel={handleCancel}
      />
    </SettingsSectionStack>
  );
}
