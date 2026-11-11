"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { WithPermissions } from "@/components/roles/with-permissions";
import { SettingsSaveBar } from "@/components/settings/settings-block";
import { Switch } from "@/components/ui/switch";
import {
  useAutoRoutingState,
  useUpdateAutoRoutingState,
} from "@/lib/auto-routing.query";
import { useFeature } from "@/lib/config/config.query";

/**
 * Whether the organization's auto routers are offered and answer requests.
 * The routers themselves are set up on the Auto Routing page.
 */
export function AutoRoutingSection() {
  const featureEnabled = useFeature("autoRoutingEnabled") === true;
  const { data: state } = useAutoRoutingState({ enabled: featureEnabled });
  const update = useUpdateAutoRoutingState();

  const saved = state?.enabled ?? false;
  const [enabled, setEnabled] = useState(saved);

  // Adopt the server value once it arrives, and again after a save replaces it.
  const lastSaved = useRef(saved);
  useEffect(() => {
    if (lastSaved.current === saved) return;
    lastSaved.current = saved;
    setEnabled(saved);
  }, [saved]);

  if (!featureEnabled || !state) return null;

  return (
    <>
      <section className="space-y-3" aria-labelledby="auto-routing-title">
        <h2 id="auto-routing-title" className="text-sm font-medium leading-5">
          Auto routing
        </h2>
        <div className="flex items-center justify-between gap-4">
          <p
            id="auto-routing-description"
            className="text-sm leading-5 text-muted-foreground"
          >
            Offer the organization&apos;s{" "}
            <Link href="/llm/auto-routing" className="underline">
              auto routers
            </Link>{" "}
            in model pickers and on the API. When off, they are hidden, and
            chats and agents already on one run on its normal model.
          </p>
          <WithPermissions
            permissions={{ llmProxy: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <div className="flex shrink-0 items-center gap-2.5">
                <span className="text-sm text-muted-foreground">
                  {enabled ? "On" : "Off"}
                </span>
                <Switch
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  disabled={update.isPending || !hasPermission}
                  aria-label="Auto routing"
                  aria-describedby="auto-routing-description"
                />
              </div>
            )}
          </WithPermissions>
        </div>
      </section>
      <SettingsSaveBar
        hasChanges={enabled !== saved}
        isSaving={update.isPending}
        permissions={{ llmProxy: ["update"] }}
        onSave={async () => {
          await update.mutateAsync(enabled);
        }}
        onCancel={() => setEnabled(saved)}
      />
    </>
  );
}
