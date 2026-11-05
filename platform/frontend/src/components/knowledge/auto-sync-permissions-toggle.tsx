// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
"use client";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useEnterpriseFeature } from "@/lib/config/config.query";

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Whether a connector resolves each document's audience from the source
 * system's own permissions at sync time.
 *
 * This used to be the third option of a sharing selector, which read as "who
 * can see this connector" and is no longer that question — who can reach a
 * connector is a grant now. What is left is a capability of the sync itself:
 * either the upstream ACL comes along with the documents, or it does not. A
 * toggle says that, and a three-way audience picker no longer can.
 */
export function AutoSyncPermissionsToggle({
  enabled,
  onEnabledChange,
  supported,
  permissionAction,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  /** Whether the chosen connector type's implementation supports permission sync. */
  supported: boolean;
  /** Connector action required for the create or edit flow. */
  permissionAction: "create" | "update";
}) {
  const enterprise = useEnterpriseFeature("knowledgeBase");
  const { data: hasPermission } = useHasPermissions({
    knowledgeSource: [permissionAction],
  });

  const lockReason = !supported
    ? "Not supported for this source."
    : !enterprise && !enabled
      ? "Enterprise feature."
      : !hasPermission && !enabled
        ? "Requires permission."
        : undefined;

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
      <div className="space-y-0.5">
        <Label htmlFor="auto-sync-permissions" className="text-sm font-medium">
          Sync permissions from the source
        </Label>
        <p className="text-muted-foreground text-xs">
          <span>
            Each document keeps the audience it has upstream, refreshed on every
            permission pass.
          </span>{" "}
          {lockReason ? <span>{lockReason}</span> : null}
        </p>
      </div>
      <Switch
        id="auto-sync-permissions"
        checked={enabled}
        disabled={Boolean(lockReason)}
        onCheckedChange={onEnabledChange}
      />
    </div>
  );
}
// SPDX-SnippetEnd
