"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { Globe, User, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { AppToolsEditor } from "@/app/apps/_parts/app-tools-editor";
import { EnvironmentSelector } from "@/components/environment-selector";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { useUpdateApp } from "@/lib/app.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAssignableTeams } from "@/lib/teams/team.query";
import type { CatalogItem } from "./mcp-server-card";

/**
 * The MCP-server settings of an owned app, edited from its registry card: the
 * app's visibility (scope + teams), environment, enabled MCP tools, and delete.
 * All writes go through the Apps API (which syncs the backing catalog), keyed by
 * the app id resolved on the catalog row.
 */
export function AppSettingsDialog({
  appId,
  item,
  open,
  onOpenChange,
}: {
  appId: string;
  item: CatalogItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{item.name}</DialogTitle>
          <DialogDescription>
            Manage who can use this app, its environment, and the MCP tools it
            can call.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Tabs defaultValue="settings">
            <TabsList>
              <TabsTrigger value="settings">Settings</TabsTrigger>
              <TabsTrigger value="tools">Tools</TabsTrigger>
            </TabsList>
            <TabsContent value="settings" className="pt-2">
              <SettingsTab appId={appId} item={item} />
            </TabsContent>
            <TabsContent value="tools" className="pt-2">
              <AppToolsEditor appId={appId} />
            </TabsContent>
          </Tabs>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

// Everything that isn't tool selection: visibility (scope + teams) and
// environment share a single Save. These edits write through to the app's
// backing catalog, so the registry card reflects them. Deletion lives in its
// own modal, opened from the card's actions menu.
function SettingsTab({ appId, item }: { appId: string; item: CatalogItem }) {
  const updateApp = useUpdateApp();
  const { data: isAppAdmin } = useHasPermissions({ app: ["admin"] });
  const { data: isAppTeamAdmin } = useHasPermissions({ app: ["team-admin"] });
  const { data: teams } = useAssignableTeams({ isResourceAdmin: !!isAppAdmin });

  const [scope, setScope] = useState<ResourceVisibilityScope>(item.scope);
  const [teamIds, setTeamIds] = useState<string[]>(item.teams.map((t) => t.id));
  const [environmentId, setEnvironmentId] = useState<string | null>(
    item.environmentId ?? null,
  );

  useEffect(() => {
    setScope(item.scope);
    setTeamIds(item.teams.map((t) => t.id));
    setEnvironmentId(item.environmentId ?? null);
  }, [item.scope, item.teams, item.environmentId]);

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

  const handleSave = async () => {
    await updateApp.mutateAsync({
      appId,
      body: {
        scope,
        teamIds: scope === "team" ? teamIds : [],
        environmentId,
      },
    });
  };

  return (
    <div className="space-y-10">
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
                placeholder={
                  hasNoTeams ? "No teams available" : "Search teams…"
                }
                emptyMessage="No teams found."
              />
            </div>
          )}
        </VisibilitySelector>
        <EnvironmentSelector
          value={environmentId}
          onChange={setEnvironmentId}
          helpText="The app can only be assigned and call MCP tools in this environment."
        />
        <div className="flex justify-end">
          <Button
            onClick={handleSave}
            disabled={updateApp.isPending || teamSelectionMissing}
          >
            {updateApp.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
