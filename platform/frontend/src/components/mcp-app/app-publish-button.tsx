"use client";

import type {
  archestraApiTypes,
  ResourceVisibilityScope,
} from "@archestra/shared";
import { Globe, User, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { useUpdateApp } from "@/lib/app.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAssignableTeams } from "@/lib/teams/team.query";

type App = archestraApiTypes.GetAppResponses["200"];

const scopeLabels: Record<ResourceVisibilityScope, string> = {
  personal: "Personal",
  team: "Teams",
  org: "Organization",
};

// Header "Publish" control: a compact button (with the current-scope icon) that
// opens a popover with the shared VisibilitySelector UI to set who can use the
// app. Edits apply via the Apps API (which syncs the backing catalog). Lives
// next to the address bar so the publish state reads at a glance from any tab.
export function AppPublishButton({ app }: { app: App }) {
  const [open, setOpen] = useState(false);
  const updateApp = useUpdateApp();
  const { data: isAppAdmin } = useHasPermissions({ app: ["admin"] });
  const { data: isAppTeamAdmin } = useHasPermissions({ app: ["team-admin"] });
  const { data: teams } = useAssignableTeams({ isResourceAdmin: !!isAppAdmin });

  const [scope, setScope] = useState<ResourceVisibilityScope>(app.scope);
  const [teamIds, setTeamIds] = useState<string[]>(app.teams.map((t) => t.id));

  // Re-seed from server state whenever the app refetches (e.g. after a save).
  useEffect(() => {
    setScope(app.scope);
    setTeamIds(app.teams.map((t) => t.id));
  }, [app.scope, app.teams]);

  const canShareTeams = isAppAdmin || isAppTeamAdmin;
  const hasNoTeams = (teams ?? []).length === 0;

  const options: VisibilityOption<ResourceVisibilityScope>[] = [
    {
      value: "personal",
      label: "Personal",
      description: "Only you can use this app",
      icon: User,
    },
    {
      value: "team",
      label: "Teams",
      description: "Share this app with selected teams",
      icon: Users,
      disabled: scope !== "team" && (!canShareTeams || hasNoTeams),
      disabledReason: !canShareTeams
        ? "You need app:team-admin permission to share with teams"
        : hasNoTeams
          ? "No teams are available to share with"
          : undefined,
    },
    {
      value: "org",
      label: "Organization",
      description: "Anyone in your org can use this app",
      icon: Globe,
      disabled: scope !== "org" && !isAppAdmin,
      disabledReason: !isAppAdmin
        ? "You need app:admin permission to make this available org-wide"
        : undefined,
    },
  ];

  const teamSelectionMissing = scope === "team" && teamIds.length === 0;

  const handleApply = async () => {
    await updateApp.mutateAsync({
      appId: app.id,
      body: { scope, teamIds: scope === "team" ? teamIds : [] },
    });
    setOpen(false);
  };

  return (
    // modal: the panel body is a sandboxed iframe, whose pointer events don't
    // reach the host document — a non-modal popover wouldn't dismiss when
    // clicking the app. The dismiss layer captures those outside clicks.
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Closing without applying (outside click / Escape) discards unsaved
        // edits — re-seed from the app's current state so a reopen is clean.
        if (!next) {
          setScope(app.scope);
          setTeamIds(app.teams.map((t) => t.id));
        }
        setOpen(next);
      }}
      modal
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="default"
          size="sm"
          className="h-7 shrink-0 gap-1.5 px-2.5 text-xs font-medium"
          aria-label={`Publish — who can use this app: ${scopeLabels[app.scope]}`}
          title="Publish — change who can use this app"
        >
          Publish
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <VisibilitySelector
          heading="Who can use this app"
          value={scope}
          options={options}
          onValueChange={setScope}
        >
          {scope === "team" && (
            <div className="space-y-2">
              <Label>Teams</Label>
              <MultiSelectCombobox
                disabled={!canShareTeams || hasNoTeams}
                options={
                  teams?.map((team) => ({
                    value: team.id,
                    label: team.name,
                  })) ?? []
                }
                value={teamIds}
                onChange={setTeamIds}
                placeholder={
                  hasNoTeams ? "No teams available" : "Search teams…"
                }
                emptyMessage="No teams found."
              />
            </div>
          )}
        </VisibilitySelector>

        <div className="mt-4 flex justify-end">
          <Button
            size="sm"
            onClick={handleApply}
            disabled={updateApp.isPending || teamSelectionMissing}
          >
            {updateApp.isPending ? "Updating…" : "Update"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
