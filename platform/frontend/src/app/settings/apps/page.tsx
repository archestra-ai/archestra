"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { useEffect, useRef, useState } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { Switch } from "@/components/ui/switch";
import {
  useOrganization,
  useUpdateSecuritySettings,
} from "@/lib/organization.query";

/**
 * How apps behave when an agent creates one. Both settings apply to new apps
 * only — an app that already exists is never retroactively disabled or locked.
 */
export default function AppsSettingsPage() {
  const { data: organization } = useOrganization();
  const updateMutation = useUpdateSecuritySettings(
    "App settings updated",
    "Failed to update app settings",
  );

  const savedDisabled = organization?.newAppsDisabledByDefault ?? false;
  const savedLocked = organization?.newAppsLockedByDefault ?? false;

  const [disabledByDefault, setDisabledByDefault] = useState(savedDisabled);
  const [lockedByDefault, setLockedByDefault] = useState(savedLocked);

  // Adopt what the server holds once the organization arrives, and again
  // after a save replaces it.
  const savedKey = `${savedDisabled}:${savedLocked}`;
  const lastSavedKey = useRef(savedKey);
  useEffect(() => {
    if (lastSavedKey.current === savedKey) return;
    lastSavedKey.current = savedKey;
    setDisabledByDefault(savedDisabled);
    setLockedByDefault(savedLocked);
  }, [savedKey, savedDisabled, savedLocked]);

  const hasChanges =
    disabledByDefault !== savedDisabled || lockedByDefault !== savedLocked;

  const handleSave = async () => {
    await updateMutation.mutateAsync({
      newAppsDisabledByDefault: disabledByDefault,
      newAppsLockedByDefault: lockedByDefault,
    });
  };

  const handleCancel = () => {
    setDisabledByDefault(savedDisabled);
    setLockedByDefault(savedLocked);
  };

  return (
    <SettingsSectionStack>
      <SettingsBlock
        title="New Apps Are Disabled by Default"
        description={
          <>
            Create every new app disabled: author-only, invisible to agents and
            runnable by nobody until its author enables it in App settings. The
            chat it was created in can finish building it first, so a new app is
            not stranded as an empty shell. Existing apps are unaffected.{" "}
            <ExternalDocsLink
              href={getDocsUrl(DocsPage.PlatformApps, "defaults-for-new-apps")}
              className="text-primary hover:underline"
              showIcon={false}
            >
              Learn more.
            </ExternalDocsLink>
          </>
        }
        control={
          <WithPermissions
            permissions={{ agentSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <Switch
                checked={disabledByDefault}
                onCheckedChange={setDisabledByDefault}
                disabled={updateMutation.isPending || !hasPermission}
              />
            )}
          </WithPermissions>
        }
      />
      <SettingsBlock
        title="New Apps Are Locked by Default"
        description={
          <>
            Create every new app locked: immutable to agents until a user
            unlocks it, in App settings or by asking an agent directly. The chat
            it was created in can finish building it first, so a new app is not
            frozen as an empty shell. Existing apps are unaffected.{" "}
            <ExternalDocsLink
              href={getDocsUrl(DocsPage.PlatformApps, "locking-an-app")}
              className="text-primary hover:underline"
              showIcon={false}
            >
              Learn more.
            </ExternalDocsLink>
          </>
        }
        control={
          <WithPermissions
            permissions={{ agentSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <Switch
                checked={lockedByDefault}
                onCheckedChange={setLockedByDefault}
                disabled={updateMutation.isPending || !hasPermission}
              />
            )}
          </WithPermissions>
        }
      />
      <SettingsSaveBar
        hasChanges={hasChanges}
        isSaving={updateMutation.isPending}
        permissions={{ agentSettings: ["update"] }}
        onSave={handleSave}
        onCancel={handleCancel}
      />
    </SettingsSectionStack>
  );
}
