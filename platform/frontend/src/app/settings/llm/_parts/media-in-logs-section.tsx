"use client";

import { useEffect, useRef, useState } from "react";
import { WithPermissions } from "@/components/roles/with-permissions";
import { SettingsSaveBar } from "@/components/settings/settings-block";
import { Switch } from "@/components/ui/switch";
import {
  useOrganization,
  useUpdateSecuritySettings,
} from "@/lib/organization.query";

/**
 * Whether LLM proxy and MCP gateway logs keep the images, audio and files
 * each call carried. Off by default: new rows mark where media was and keep
 * everything else.
 */
export function MediaInLogsSection() {
  const { data: organization } = useOrganization();
  const updateMutation = useUpdateSecuritySettings(
    "Log settings updated",
    "Failed to update log settings",
  );

  const saved = organization?.keepMediaInLogs ?? false;
  const [kept, setKept] = useState(saved);

  // Adopt the server value once it arrives, and again after a save replaces it.
  const lastSaved = useRef(saved);
  useEffect(() => {
    if (lastSaved.current === saved) return;
    lastSaved.current = saved;
    setKept(saved);
  }, [saved]);

  const handleSave = async () => {
    await updateMutation.mutateAsync({ keepMediaInLogs: kept });
  };

  return (
    <>
      <section className="space-y-3" aria-labelledby="media-in-logs-title">
        <h2 id="media-in-logs-title" className="text-sm font-medium leading-5">
          Keep media in logs
        </h2>
        <div className="flex items-center justify-between gap-4">
          <p
            id="media-in-logs-description"
            className="text-sm leading-5 text-muted-foreground"
          >
            Store the images, audio and files in LLM and MCP calls, so Logs can
            show and play them. When off, new log rows show where media was but
            do not keep it.
          </p>
          <WithPermissions
            permissions={{ organizationSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <div className="flex shrink-0 items-center gap-2.5">
                <span className="text-sm text-muted-foreground">
                  {kept ? "On" : "Off"}
                </span>
                <Switch
                  checked={kept}
                  onCheckedChange={setKept}
                  disabled={updateMutation.isPending || !hasPermission}
                  aria-label="Keep media in logs"
                  aria-describedby="media-in-logs-description"
                />
              </div>
            )}
          </WithPermissions>
        </div>
      </section>
      <SettingsSaveBar
        hasChanges={kept !== saved}
        isSaving={updateMutation.isPending}
        permissions={{ organizationSettings: ["update"] }}
        onSave={handleSave}
        onCancel={() => setKept(saved)}
      />
    </>
  );
}
