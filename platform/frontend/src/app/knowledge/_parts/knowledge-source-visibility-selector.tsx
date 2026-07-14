// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
"use client";

import { Globe, RefreshCw, Users } from "lucide-react";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import {
  VisibilitySelector as SharedVisibilitySelector,
  type VisibilityOption,
} from "@/components/visibility-selector";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useEnterpriseFeature, useFeature } from "@/lib/config/config.query";
import { useTeams } from "@/lib/teams/team.query";

export type KnowledgeSourceVisibility =
  | "org-wide"
  | "team-scoped"
  | "auto-sync-permissions";

const VISIBILITY_OPTIONS: Record<
  KnowledgeSourceVisibility,
  VisibilityOption<KnowledgeSourceVisibility>
> = {
  "org-wide": {
    value: "org-wide",
    label: "Organization",
    description: "Anyone in your org can access this knowledge source",
    icon: Globe,
  },
  "team-scoped": {
    value: "team-scoped",
    label: "Teams",
    description: "Share this knowledge source with selected teams",
    icon: Users,
  },
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  "auto-sync-permissions": {
    value: "auto-sync-permissions",
    label: "Auto-sync permissions",
    description: "Sync access from the source system's own permissions",
    icon: RefreshCw,
  },
  // SPDX-SnippetEnd
};

const visibilityEntries = Object.entries(VISIBILITY_OPTIONS) as [
  KnowledgeSourceVisibility,
  VisibilityOption<KnowledgeSourceVisibility>,
][];

export function KnowledgeSourceVisibilitySelector({
  visibility,
  onVisibilityChange,
  teamIds,
  onTeamIdsChange,
  showTeamRequired,
  supportsAutoSync = false,
  autoSyncPermissionAction,
}: {
  visibility: KnowledgeSourceVisibility;
  onVisibilityChange: (visibility: KnowledgeSourceVisibility) => void;
  teamIds: string[];
  onTeamIdsChange: (ids: string[]) => void;
  showTeamRequired?: boolean;
  /** Whether the chosen connector type's implementation supports permission sync. */
  supportsAutoSync?: boolean;
  /**
   * Which knowledgeSourceAutoSync action the backend will require when the
   * caller selects auto-sync: "create" for the create-connector flow,
   * "update" when editing an existing connector.
   */
  autoSyncPermissionAction: "create" | "update";
}) {
  const { data: teams } = useTeams();
  const knowledgeBaseEnterprise = useEnterpriseFeature("knowledgeBase");
  // BETA: with the flag off the auto-sync option is hidden entirely — unless
  // the connector already uses it, so the selector never shows a value it has
  // no option for.
  const autoSyncBeta = useFeature("kbAutoSyncPermissionsEnabled") ?? false;
  // Selecting auto-sync requires the dedicated knowledgeSourceAutoSync
  // permission (admin-only by default; the backend rejects everyone else).
  const { data: hasAutoSyncPermission } = useHasPermissions({
    knowledgeSourceAutoSync: [autoSyncPermissionAction],
  });

  const options = visibilityEntries
    .filter(
      ([value]) =>
        value !== "auto-sync-permissions" ||
        autoSyncBeta ||
        visibility === "auto-sync-permissions",
    )
    .map(([value, option]) => {
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      // Keep team-scoped visible per spec; disable when enterprise access
      // control isn't active or there are no teams yet.
      const isTeamScoped = value === "team-scoped";
      const noTeams = isTeamScoped && (teams ?? []).length === 0;
      const enterpriseLocked =
        isTeamScoped &&
        !knowledgeBaseEnterprise &&
        visibility !== "team-scoped";

      // Auto-sync-permissions: gated by the enterprise flag AND the connector
      // type supporting permission sync (Stage 1: GitHub / Confluence / Jira).
      const isAutoSync = value === "auto-sync-permissions";
      const alreadyAutoSync = visibility === "auto-sync-permissions";
      const autoSyncEnterpriseLocked =
        isAutoSync && !knowledgeBaseEnterprise && !alreadyAutoSync;
      const autoSyncUnsupported = isAutoSync && !supportsAutoSync;
      const autoSyncPermissionLocked =
        isAutoSync && !hasAutoSyncPermission && !alreadyAutoSync;
      // SPDX-SnippetEnd

      const disabled =
        noTeams ||
        enterpriseLocked ||
        autoSyncEnterpriseLocked ||
        autoSyncUnsupported ||
        autoSyncPermissionLocked;
      const disabledLabel =
        enterpriseLocked || autoSyncEnterpriseLocked
          ? "Enterprise feature"
          : autoSyncUnsupported
            ? "Not supported for this source"
            : autoSyncPermissionLocked
              ? "Requires permission"
              : noTeams
                ? "No teams available"
                : undefined;
      return { ...option, value, disabled, disabledLabel };
    });

  return (
    <SharedVisibilitySelector
      value={visibility}
      options={options}
      onValueChange={onVisibilityChange}
    >
      {visibility === "team-scoped" && (
        <div className="space-y-2">
          <Label>
            Teams
            {showTeamRequired && (
              <span className="text-destructive ml-1">(required)</span>
            )}
          </Label>
          <MultiSelectCombobox
            options={
              teams?.map((team) => ({
                value: team.id,
                label: team.name,
              })) || []
            }
            value={teamIds}
            onChange={onTeamIdsChange}
            placeholder={
              teams?.length === 0 ? "No teams available" : "Search teams..."
            }
            emptyMessage="No teams found."
          />
        </div>
      )}
    </SharedVisibilitySelector>
  );
}
