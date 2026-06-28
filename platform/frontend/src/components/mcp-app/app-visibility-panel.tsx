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
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { useUpdateApp } from "@/lib/app.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAssignableTeams } from "@/lib/teams/team.query";

type App = archestraApiTypes.GetAppResponses["200"];

// Who-can-use-this-app control for the side panel's Visibility tab: scope
// (personal / teams / org) plus team selection, applied via the Apps API (which
// syncs the backing catalog). Ported from the former /apps/[appId] publish
// dropdown, inlined as a tab body.
export function AppVisibilityPanel({ app }: { app: App }) {
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
  };

  return (
    <div className="space-y-4">
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
              placeholder={hasNoTeams ? "No teams available" : "Search teams…"}
              emptyMessage="No teams found."
            />
          </div>
        )}
      </VisibilitySelector>

      <div className="flex justify-end">
        <Button
          onClick={handleApply}
          disabled={updateApp.isPending || teamSelectionMissing}
        >
          {updateApp.isPending ? "Updating…" : "Update"}
        </Button>
      </div>
    </div>
  );
}
