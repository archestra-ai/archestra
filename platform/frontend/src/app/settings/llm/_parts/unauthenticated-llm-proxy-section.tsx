"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
} from "@/components/settings/settings-block";
import { Switch } from "@/components/ui/switch";
import {
  useOrganization,
  useUpdateSecuritySettings,
} from "@/lib/organization.query";

/**
 * Lets LLM proxy requests run without an Archestra credential. Off by default.
 * The risk is shown whether or not the setting is on, so the choice is made
 * with the reasons in front of the admin.
 */
export function UnauthenticatedLlmProxySection() {
  const { data: organization } = useOrganization();
  const updateMutation = useUpdateSecuritySettings(
    "LLM proxy settings updated",
    "Failed to update LLM proxy settings",
  );

  const saved = organization?.allowUnauthenticatedLlmProxyRequests ?? false;
  const [allowed, setAllowed] = useState(saved);

  // Adopt the server value once it arrives, and again after a save replaces it.
  const lastSaved = useRef(saved);
  useEffect(() => {
    if (lastSaved.current === saved) return;
    lastSaved.current = saved;
    setAllowed(saved);
  }, [saved]);

  const handleSave = async () => {
    await updateMutation.mutateAsync({
      allowUnauthenticatedLlmProxyRequests: allowed,
    });
  };

  return (
    <>
      <SettingsBlock
        title="Allow requests without an Archestra key"
        description="Accept LLM proxy requests that carry only a provider key, or none."
        control={
          <WithPermissions
            permissions={{ organizationSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <div className="flex items-center gap-2.5">
                <span className="text-sm text-muted-foreground">
                  {allowed ? "On" : "Off"}
                </span>
                <Switch
                  checked={allowed}
                  onCheckedChange={setAllowed}
                  disabled={updateMutation.isPending || !hasPermission}
                  aria-label="Allow requests without an Archestra key"
                />
              </div>
            )}
          </WithPermissions>
        }
        notice={
          <div className="space-y-3">
            <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
              <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                Dangerous
              </p>
              <p className="text-sm leading-5 text-amber-900/80 dark:text-amber-200/80">
                These requests are not tied to a user, so per-user limits and
                attribution don't apply. Keyless self-hosted upstreams such as
                Ollama or vLLM become reachable by anyone who can reach the
                proxy.
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              Next step:{" "}
              <Link
                href="/llm/proxy"
                className="font-medium text-foreground underline"
              >
                Set up the LLM proxy
              </Link>
            </p>
          </div>
        }
      />
      <SettingsSaveBar
        hasChanges={allowed !== saved}
        isSaving={updateMutation.isPending}
        permissions={{ organizationSettings: ["update"] }}
        onSave={handleSave}
        onCancel={() => setAllowed(saved)}
      />
    </>
  );
}
