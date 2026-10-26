"use client";

import { AlertTriangle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { WithPermissions } from "@/components/roles/with-permissions";
import { SettingsSaveBar } from "@/components/settings/settings-block";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
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
      <section
        className="space-y-3"
        aria-labelledby="unauthenticated-llm-proxy-title"
      >
        <h2
          id="unauthenticated-llm-proxy-title"
          className="text-sm font-medium leading-5"
        >
          Allow requests without a virtual key
        </h2>
        <InlineNotice variant="warning">
          <AlertTriangle />
          <InlineNoticeBody>
            <span className="font-medium">Dangerous</span>
            <InlineNoticeText>
              These requests are not tied to a user, so per-user limits and
              attribution don't apply. Keyless self-hosted upstreams such as
              Ollama or vLLM become reachable by anyone who can reach the proxy.
            </InlineNoticeText>
          </InlineNoticeBody>
        </InlineNotice>
        <div className="flex items-center justify-between gap-4">
          <p
            id="unauthenticated-llm-proxy-description"
            className="text-sm leading-5 text-muted-foreground"
          >
            Accept LLM proxy requests that carry only a provider key, or none.
          </p>
          <WithPermissions
            permissions={{ organizationSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <div className="flex shrink-0 items-center gap-2.5">
                <span className="text-sm text-muted-foreground">
                  {allowed ? "On" : "Off"}
                </span>
                <Switch
                  checked={allowed}
                  onCheckedChange={setAllowed}
                  disabled={updateMutation.isPending || !hasPermission}
                  aria-label="Allow requests without a virtual key"
                  aria-describedby="unauthenticated-llm-proxy-description"
                />
              </div>
            )}
          </WithPermissions>
        </div>
      </section>
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
