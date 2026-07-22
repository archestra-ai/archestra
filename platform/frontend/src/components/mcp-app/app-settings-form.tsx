"use client";

import type {
  archestraApiTypes,
  ResourceVisibilityScope,
} from "@archestra/shared";
import { Globe, User, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { AppToolsEditor } from "@/app/apps/_parts/app-tools-editor";
import { EnvironmentSelector } from "@/components/environment-selector";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import {
  useAppTools,
  useAssignToolToApp,
  useSetAppEnabled,
  useUnassignToolFromApp,
  useUpdateApp,
} from "@/lib/app.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAssignableTeams } from "@/lib/teams/team.query";

type App = archestraApiTypes.GetAppResponses["200"];

type FormValues = { name: string; description: string };

// The whole-app settings fields, hosted by `AppSettingsDialog` (apps-page cards
// and the side panel both open that dialog). It folds the previously separate
// rename dialog, manage-tools dialog, and publish popover into one staged form
// committed by a single Save: identity (name/description), the bound environment
// + assigned tools, and visibility (scope + teams). The dialog owns the Save
// button (wired to this form via `formId`) and Cancel; `onStatusChange` reports
// saving/validity up so that button can disable/spin. Delete is intentionally
// NOT here — it's a separate destructive action owned by each host.
export function AppSettingsForm({
  app,
  onBack,
  formId,
  onStatusChange,
}: {
  app: App;
  onBack: () => void;
  /** Ties the host's submit button to this form via the HTML `form` attr. */
  formId: string;
  /** Reports save button state (must be a stable callback, e.g. a setState). */
  onStatusChange?: (status: { saving: boolean; disabled: boolean }) => void;
}) {
  const { data: canUpdate } = useHasPermissions({ app: ["update"] });
  const { data: isAppAdmin } = useHasPermissions({ app: ["admin"] });
  const { data: isAppTeamAdmin } = useHasPermissions({ app: ["team-admin"] });
  const { data: teams } = useAssignableTeams({ isResourceAdmin: !!isAppAdmin });

  const updateApp = useUpdateApp();
  const setEnabled = useSetAppEnabled();
  const assignTool = useAssignToolToApp();
  const unassignTool = useUnassignToolFromApp();
  const appToolsQuery = useAppTools(app.id);
  const assignedTools = appToolsQuery.data;

  const form = useForm<FormValues>({
    defaultValues: { name: app.name, description: app.description ?? "" },
  });

  const [environmentId, setEnvironmentId] = useState<string | null>(
    app.environmentId ?? null,
  );
  const [enabledStatus, setEnabledStatus] = useState<"disabled" | "enabled">(
    app.enabled ? "enabled" : "disabled",
  );
  const [scope, setScope] = useState<ResourceVisibilityScope>(app.scope);
  const [teamIds, setTeamIds] = useState<string[]>(app.teams.map((t) => t.id));
  const [selectedToolIds, setSelectedToolIds] = useState<Set<string>>(
    () => new Set(),
  );
  // The server assignment set this form's staged selection is relative to;
  // null until the first successful load. Save diffs staged vs this snapshot,
  // never vs a later refetch — otherwise a tool assigned concurrently by
  // another client would be unassigned by an unrelated save here.
  const [seededToolIds, setSeededToolIds] = useState<Set<string> | null>(null);
  const toolsSeeded = seededToolIds !== null;

  // Seed the staged tool selection once, when the assignments first land — a
  // later background refetch must not overwrite the user's staged edits.
  useEffect(() => {
    if (!toolsSeeded && assignedTools) {
      setSelectedToolIds(new Set(assignedTools.map((t) => t.id)));
      setSeededToolIds(new Set(assignedTools.map((t) => t.id)));
    }
  }, [assignedTools, toolsSeeded]);

  const canShareTeams = isAppAdmin || isAppTeamAdmin;
  const hasNoTeams = (teams ?? []).length === 0;

  const enabledOptions = [
    {
      value: "disabled" as const,
      label: "Disabled",
      description:
        "You can edit and preview it, but Agents and the MCP Gateway can't reach it",
    },
    {
      value: "enabled" as const,
      label: "Enabled",
      description:
        "Reachable from Agents and the MCP Gateway, for everyone in the scope above",
    },
  ];
  const selectedEnabledDescription = enabledOptions.find(
    (option) => option.value === enabledStatus,
  )?.description;

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
  // Save waits only while the assignments query is in flight. If it errors,
  // Save re-enables: identity/visibility still save, and the tool diff is
  // skipped below while the selection is unseeded (clearing it by accident is
  // the thing this guards against).
  const toolsLoading = appToolsQuery.isPending;
  // Only the mutation drives the button's loading label; data-loading does not.
  const saving =
    updateApp.isPending ||
    setEnabled.isPending ||
    assignTool.isPending ||
    unassignTool.isPending;

  // Drive the top bar's save button (it lives outside this form).
  useEffect(() => {
    onStatusChange?.({
      saving,
      disabled: saving || toolsLoading || teamSelectionMissing,
    });
  }, [saving, toolsLoading, teamSelectionMissing, onStatusChange]);

  // Serializes the handler itself: the state-based `saving` guard lags a
  // render, so a rapid resubmit could reread a stale tool-diff snapshot and
  // resend already-applied mutations.
  const submitInFlight = useRef(false);

  const onSubmit = form.handleSubmit(async (values) => {
    if (submitInFlight.current) return;
    if (saving || toolsLoading || teamSelectionMissing) return;
    submitInFlight.current = true;
    try {
      await submitSettings(values);
    } finally {
      submitInFlight.current = false;
    }
  });

  async function submitSettings(values: FormValues) {
    // Enable/disable is a distinct lifecycle transition on the backend (its
    // own endpoint, authorized against the app's current scope), so a changed
    // selection commits via its own call rather than riding the PATCH body.
    const enabled = enabledStatus === "enabled";
    if (enabled !== app.enabled) {
      const result = await setEnabled.mutateAsync({
        appId: app.id,
        enabled,
      });
      if (!result) return;
    }
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

    if (canUpdate && seededToolIds) {
      const results = await Promise.all([
        ...[...selectedToolIds]
          .filter((id) => !seededToolIds.has(id))
          .map(async (id) => ({
            id,
            kind: "assign" as const,
            ok:
              (await assignTool.mutateAsync({
                appId: app.id,
                toolId: id,
                body: { credentialResolutionMode: "dynamic" },
              })) !== null,
          })),
        ...[...seededToolIds]
          .filter((id) => !selectedToolIds.has(id))
          .map(async (id) => ({
            id,
            kind: "unassign" as const,
            ok:
              (await unassignTool.mutateAsync({
                appId: app.id,
                toolId: id,
              })) !== null,
          })),
      ]);
      // Fold the applied changes into the snapshot so a retry after a partial
      // failure re-sends only the still-unapplied diff.
      setSeededToolIds((prev) => {
        const next = new Set(prev);
        for (const r of results) {
          if (!r.ok) continue;
          if (r.kind === "assign") next.add(r.id);
          else next.delete(r.id);
        }
        return next;
      });
      // A failed tool change already toasted; stay open so the staged
      // selection survives and Save can retry the remaining diff.
      if (results.some((r) => !r.ok)) return;
    }
    onBack();
  }

  return (
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
                aria-invalid={!!form.formState.errors.name}
                {...form.register("name", {
                  required: "Name is required.",
                  maxLength: {
                    value: 100,
                    message: "Name must be 100 characters or fewer.",
                  },
                  validate: (value) =>
                    value.trim().length > 0 || "Name is required.",
                })}
              />
              {form.formState.errors.name?.message ? (
                <p className="text-xs text-destructive">
                  {form.formState.errors.name.message}
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="app-settings-description">Description</Label>
              <Textarea
                id="app-settings-description"
                aria-invalid={!!form.formState.errors.description}
                {...form.register("description", {
                  maxLength: {
                    value: 500,
                    message: "Description must be 500 characters or fewer.",
                  },
                })}
              />
              {form.formState.errors.description?.message ? (
                <p className="text-xs text-destructive">
                  {form.formState.errors.description.message}
                </p>
              ) : null}
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

          <div className="space-y-2">
            <Label>App status</Label>
            <Select
              value={enabledStatus}
              onValueChange={(next) =>
                setEnabledStatus(next as "disabled" | "enabled")
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {enabledOptions.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    description={option.description}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedEnabledDescription ? (
              <p className="text-xs text-muted-foreground">
                {selectedEnabledDescription}
              </p>
            ) : null}
          </div>
        </VisibilitySelector>

        {canUpdate && (
          <>
            <EnvironmentSelector
              value={environmentId}
              onChange={setEnvironmentId}
              resource="app"
              helpText="The app can only be assigned and call MCP tools in this environment."
            />

            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Tools</h3>
              {toolsSeeded ? (
                <AppToolsEditor
                  appId={app.id}
                  environmentId={environmentId}
                  selectedToolIds={selectedToolIds}
                  onSelectionChange={setSelectedToolIds}
                />
              ) : (
                // Unseeded selection: the checklist would misrepresent every
                // assigned tool as unchecked, and staged edits would be
                // dropped by the save's unseeded-diff skip.
                <p className="text-sm text-muted-foreground">
                  {appToolsQuery.isPending
                    ? "Loading tools…"
                    : "Tool assignments couldn't be loaded. Saving keeps the app's current tools."}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </form>
  );
}
