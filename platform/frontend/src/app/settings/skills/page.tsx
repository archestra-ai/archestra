"use client";

import { useEffect, useState } from "react";
import { LoadingState } from "@/components/loading";
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

const MARKETPLACE_ACCESS_LABELS = {
  authenticated: "Require a token",
  anonymous: "Allow anonymous clones",
} as const;

export default function SkillsSettingsPage() {
  const { data: organization, isPending } = useOrganization();
  const updateSkillsSettingsMutation = useUpdateSkillsSettings(
    "Skills settings updated",
    "Failed to update Skills settings",
  );

  const serverCatalogEnabled = organization?.onlineSkillCatalogEnabled ?? true;
  const serverAnonymousAccess =
    organization?.skillMarketplaceAnonymousAccess ?? false;
  const [catalogEnabled, setCatalogEnabled] = useState(serverCatalogEnabled);
  const [anonymousAccess, setAnonymousAccess] = useState(serverAnonymousAccess);

  useEffect(() => {
    if (!organization) return;
    setCatalogEnabled(organization.onlineSkillCatalogEnabled);
    setAnonymousAccess(organization.skillMarketplaceAnonymousAccess);
  }, [organization]);

  const hasChanges =
    !isPending &&
    (catalogEnabled !== serverCatalogEnabled ||
      anonymousAccess !== serverAnonymousAccess);

  const handleSave = async () => {
    if (!hasChanges) return;
    await updateSkillsSettingsMutation.mutateAsync({
      onlineSkillCatalogEnabled: catalogEnabled,
      skillMarketplaceAnonymousAccess: anonymousAccess,
    });
  };

  const handleCancel = () => {
    setCatalogEnabled(serverCatalogEnabled);
    setAnonymousAccess(serverAnonymousAccess);
  };

  if (isPending) {
    return <LoadingState variant="page" />;
  }

  return (
    <SettingsSectionStack>
      <SettingsBlock
        title="Online skill catalog"
        description="Let people discover and import skills from the public online catalog — the popular-repository list, the skill index search, and GitHub-repo imports on the add-skill page. When disabled, the add-skill page opens the blank-template editor directly, and the catalog and GitHub-import API endpoints are refused too, so scripts and agents cannot reach around the setting. Writing skills by hand stays available."
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
      <SettingsBlock
        title="Skills marketplace access"
        description="How clients authenticate against the shared marketplace URL on the Connect page. With a token, each person clones as themselves and installs the skills they can see. Anonymous clones need no credential at all and expose the organization-wide skills to anyone who can reach this deployment; personal and team skills are never included."
        control={
          <WithPermissions
            permissions={{ skillsSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <Select
                value={anonymousAccess ? "anonymous" : "authenticated"}
                onValueChange={(value) =>
                  setAnonymousAccess(value === "anonymous")
                }
                disabled={
                  updateSkillsSettingsMutation.isPending || !hasPermission
                }
              >
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(MARKETPLACE_ACCESS_LABELS).map(
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
