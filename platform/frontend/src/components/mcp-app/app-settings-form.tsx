"use client";

import type {
  archestraApiTypes,
  ResourceVisibilityScope,
} from "@archestra/shared";
import { Globe, User, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { AppDeleteDialog } from "@/app/apps/_parts/app-delete-dialog";
import { AppToolsEditor } from "@/app/apps/_parts/app-tools-editor";
import { EnvironmentSelector } from "@/components/environment-selector";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { Textarea } from "@/components/ui/textarea";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import {
  useAppTools,
  useAssignToolToApp,
  useUnassignToolFromApp,
  useUpdateApp,
} from "@/lib/app.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAssignableTeams } from "@/lib/teams/team.query";

type App = archestraApiTypes.GetAppResponses["200"];

type FormValues = { name: string; description: string };

// The whole-app settings page rendered inline in the right panel, replacing the
// app's iframe body. It folds the previously separate rename dialog, manage-tools
// dialog, and publish popover into one staged form committed by a single Save:
// identity (name/description), the bound environment + assigned tools, and
// visibility (scope + teams). The card's top bar owns the controls — a back arrow
// (cancel, discards edits) and a save action wired to this form via `formId` —
// so the form body is just the scrollable fields. `onStatusChange` reports
// saving/validity up so the top bar's save button can disable/spin. Delete lives
// in its own zone below the fields and keeps the confirmation dialog.
export function AppSettingsForm({
  app,
  onBack,
  formId,
  onStatusChange,
  onDeleted,
}: {
  app: App;
  onBack: () => void;
  /** Ties the top bar's submit button to this form via the HTML `form` attr. */
  formId: string;
  /** Reports save button state (must be a stable callback, e.g. a setState). */
  onStatusChange?: (status: { saving: boolean; disabled: boolean }) => void;
  /** Called after the app is deleted — e.g. to close the panel. */
  onDeleted?: () => void;
}) {
  const { data: canUpdate } = useHasPermissions({ app: ["update"] });
  const { data: canDelete } = useHasPermissions({ app: ["delete"] });
  const { data: isAppAdmin } = useHasPermissions({ app: ["admin"] });
  const { data: isAppTeamAdmin } = useHasPermissions({ app: ["team-admin"] });
  const { data: teams } = useAssignableTeams({ isResourceAdmin: !!isAppAdmin });

  const updateApp = useUpdateApp();
  const assignTool = useAssignToolToApp();
  const unassignTool = useUnassignToolFromApp();
  const { data: assignedTools } = useAppTools(app.id);

  const form = useForm<FormValues>({
    defaultValues: { name: app.name, description: app.description ?? "" },
  });

  const [environmentId, setEnvironmentId] = useState<string | null>(
    app.environmentId ?? null,
  );
  const [scope, setScope] = useState<ResourceVisibilityScope>(app.scope);
  const [teamIds, setTeamIds] = useState<string[]>(app.teams.map((t) => t.id));
  const [selectedToolIds, setSelectedToolIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Seed the staged tool selection once the assignments land.
  useEffect(() => {
    if (assignedTools) {
      setSelectedToolIds(new Set(assignedTools.map((t) => t.id)));
    }
  }, [assignedTools]);

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
  // Tool assignments must land before saving (an unseeded selection would clear
  // them), so this disables the button — but it is not a "Saving…" state.
  const toolsLoading = !assignedTools;
  // Only the mutation drives the button's loading label; data-loading does not.
  const saving =
    updateApp.isPending || assignTool.isPending || unassignTool.isPending;

  // Drive the top bar's save button (it lives outside this form).
  useEffect(() => {
    onStatusChange?.({
      saving,
      disabled: saving || toolsLoading || teamSelectionMissing,
    });
  }, [saving, toolsLoading, teamSelectionMissing, onStatusChange]);

  const onSubmit = form.handleSubmit(async (values) => {
    if (saving || toolsLoading || teamSelectionMissing) return;
    // Visibility is editable on its own permissions; identity + environment only
    // when the caller can update the app, so omit those fields otherwise (mirrors
    // the field-limited bodies the old publish popover / rename dialog sent).
    const body: archestraApiTypes.UpdateAppData["body"] = {
      scope,
      teamIds: scope === "team" ? teamIds : [],
    };
    if (canUpdate) {
      body.name = values.name.trim();
      body.description = values.description.trim() || null;
      body.environmentId = environmentId;
    }
    const result = await updateApp.mutateAsync({ appId: app.id, body });
    if (!result) return;

    if (canUpdate) {
      const current = new Set((assignedTools ?? []).map((t) => t.id));
      await Promise.all([
        ...[...selectedToolIds]
          .filter((id) => !current.has(id))
          .map((id) =>
            assignTool.mutateAsync({
              appId: app.id,
              toolId: id,
              body: { credentialResolutionMode: "dynamic" },
            }),
          ),
        ...[...current]
          .filter((id) => !selectedToolIds.has(id))
          .map((id) => unassignTool.mutateAsync({ appId: app.id, toolId: id })),
      ]);
    }
    onBack();
  });

  return (
    <div className="flex h-full flex-col">
      <form
        id={formId}
        onSubmit={onSubmit}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
          {canUpdate && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="app-settings-name">Name</Label>
                <Input
                  id="app-settings-name"
                  {...form.register("name", { required: true, maxLength: 100 })}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="app-settings-description">Description</Label>
                <Textarea
                  id="app-settings-description"
                  {...form.register("description", { maxLength: 500 })}
                />
              </div>
            </>
          )}

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

          {canUpdate && (
            <>
              <EnvironmentSelector
                value={environmentId}
                onChange={setEnvironmentId}
                helpText="The app can only be assigned and call MCP tools in this environment."
              />

              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Tools</h3>
                <AppToolsEditor
                  appId={app.id}
                  environmentId={environmentId}
                  selectedToolIds={selectedToolIds}
                  onSelectionChange={setSelectedToolIds}
                  unbounded
                />
              </div>
            </>
          )}

          {canDelete && (
            <div className="mt-2 space-y-3 border-t pt-6">
              <div>
                <h3 className="text-sm font-semibold text-destructive">
                  Delete app
                </h3>
                <p className="text-xs text-muted-foreground">
                  Permanently removes the app and its version history. This
                  cannot be undone.
                </p>
              </div>
              <Button
                type="button"
                variant="destructive"
                onClick={() => setDeleteOpen(true)}
              >
                Delete app
              </Button>
            </div>
          )}
        </div>
      </form>

      <AppDeleteDialog
        app={app}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={onDeleted}
      />
    </div>
  );
}
