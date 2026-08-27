"use client";

import type {
  archestraApiTypes,
  ResourceVisibilityScope,
} from "@archestra/shared";
import { Globe, User, UserRound, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { AppToolsEditor } from "@/app/apps/_parts/app-tools-editor";
import {
  type ProfileLabel,
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";
import { EnvironmentSelector } from "@/components/environment-selector";
import { IdentityFields } from "@/components/identity-fields";
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
import { UserSearchableMultiSelect } from "@/components/user-searchable-multi-select";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import {
  useAppTools,
  useAssignToolToApp,
  useSetAppEnabled,
  useSetAppLocked,
  useUnassignToolFromApp,
  useUpdateApp,
} from "@/lib/app.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useOrganizationMembers } from "@/lib/organization.query";
import { useAssignableTeams } from "@/lib/teams/team.query";

type App = archestraApiTypes.GetAppResponses["200"];

type FormValues = {
  name: string;
  slug: string;
  description: string;
  /** Emoji character or base64 image data URL; null = the generic app glyph. */
  icon: string | null;
};

// Mirrors the backend's AppSlugSchema so a malformed URL is caught before the
// round-trip. Uniqueness is only knowable server-side and comes back as a 409.
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * What the visibility control offers. Wider than the stored scope: an app
 * shared with named people is persisted as `personal` plus grants, so "user"
 * exists only in this form, which maps it both ways.
 */
type AppVisibilityChoice = ResourceVisibilityScope | "user";

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
  const { data: session } = useSession();
  const { data: members = [] } = useOrganizationMembers();

  const updateApp = useUpdateApp();
  const setEnabled = useSetAppEnabled();
  const setLocked = useSetAppLocked();
  const assignTool = useAssignToolToApp();
  const unassignTool = useUnassignToolFromApp();
  const appToolsQuery = useAppTools(app.id);
  const assignedTools = appToolsQuery.data;

  const form = useForm<FormValues>({
    defaultValues: {
      name: app.name,
      slug: app.slug ?? "",
      description: app.description ?? "",
      icon: app.icon ?? null,
    },
  });

  const [environmentId, setEnvironmentId] = useState<string | null>(
    app.environmentId ?? null,
  );
  const [enabledStatus, setEnabledStatus] = useState<"disabled" | "enabled">(
    app.enabled ? "enabled" : "disabled",
  );
  const [lockedStatus, setLockedStatus] = useState<"unlocked" | "locked">(
    app.locked ? "locked" : "unlocked",
  );
  const [openMode, setOpenMode] = useState<"inline" | "fullscreen">(
    app.openInFullscreen ? "fullscreen" : "inline",
  );
  // The form's fourth option. On the wire an app shared with named people stays
  // `personal` and carries grants, so "user" is a UI-side reading of
  // (scope, users) — see the save path below, which maps it back.
  const [scope, setScope] = useState<AppVisibilityChoice>(
    app.scope === "personal" && app.users.length > 0 ? "user" : app.scope,
  );
  const [teamIds, setTeamIds] = useState<string[]>(app.teams.map((t) => t.id));
  const [userIds, setUserIds] = useState<string[]>(app.users.map((u) => u.id));
  const [labels, setLabels] = useState<ProfileLabel[]>(
    app.labels.map(({ key, value }) => ({ key, value })),
  );
  const labelsRef = useRef<ProfileLabelsRef>(null);
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

  // Everyone in the org but the author, who already reaches their own app —
  // offering to "share" it with themselves would be a no-op that reads as a bug.
  const memberOptions = useMemo(
    () =>
      members
        .filter((member) => member.id !== session?.user?.id)
        .map((member) => ({
          userId: member.id,
          name: member.name,
          email: member.email,
        })),
    [members, session?.user?.id],
  );

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

  const lockedOptions = [
    {
      value: "unlocked" as const,
      label: "Unlocked",
      description: "Agents (and you) can modify the app normally",
    },
    {
      value: "locked" as const,
      label: "Locked",
      description:
        "Agents refuse every change to this app, and it can't be deleted, until you unlock it",
    },
  ];
  const selectedLockedDescription = lockedOptions.find(
    (option) => option.value === lockedStatus,
  )?.description;

  const openModeOptions = [
    {
      value: "inline" as const,
      label: "Inline",
      description:
        "Opens next to the conversation, at the size the app asks for",
    },
    {
      value: "fullscreen" as const,
      label: "Fullscreen",
      description:
        "Fills the page on open, for an app you look at rather than talk to",
    },
  ];
  const selectedOpenModeDescription = openModeOptions.find(
    (option) => option.value === openMode,
  )?.description;

  const options: VisibilityOption<AppVisibilityChoice>[] = [
    {
      value: "personal",
      label: "Personal",
      description: "Only you can use this app",
      icon: User,
    },
    {
      value: "user",
      label: "Users",
      description: "Share this app with selected people",
      icon: UserRound,
      disabled: scope !== "user" && memberOptions.length === 0,
      disabledLabel:
        memberOptions.length === 0 ? "No users available" : undefined,
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
      disabledLabel: !isAppAdmin ? "Requires permission" : undefined,
      disabledReason: !isAppAdmin
        ? "You need app:admin permission to make this available org-wide"
        : undefined,
    },
  ];

  const teamSelectionMissing = scope === "team" && teamIds.length === 0;
  // Same guard as Teams: an empty Users selection would silently save as a
  // plain personal app, quietly un-sharing it.
  const userSelectionMissing = scope === "user" && userIds.length === 0;
  const selectionMissing = teamSelectionMissing || userSelectionMissing;
  // Save waits only while the assignments query is in flight. If it errors,
  // Save re-enables: identity/visibility still save, and the tool diff is
  // skipped below while the selection is unseeded (clearing it by accident is
  // the thing this guards against).
  const toolsLoading = appToolsQuery.isPending;
  // Only the mutation drives the button's loading label; data-loading does not.
  const saving =
    updateApp.isPending ||
    setEnabled.isPending ||
    setLocked.isPending ||
    assignTool.isPending ||
    unassignTool.isPending;

  // Drive the top bar's save button (it lives outside this form).
  useEffect(() => {
    onStatusChange?.({
      saving,
      disabled: saving || toolsLoading || selectionMissing,
    });
  }, [saving, toolsLoading, selectionMissing, onStatusChange]);

  // Serializes the handler itself: the state-based `saving` guard lags a
  // render, so a rapid resubmit could reread a stale tool-diff snapshot and
  // resend already-applied mutations.
  const submitInFlight = useRef(false);

  const onSubmit = form.handleSubmit(async (values) => {
    if (submitInFlight.current) return;
    if (saving || toolsLoading || selectionMissing) return;
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
    // Lock/unlock is a lifecycle transition like enable/disable, committed via
    // its own endpoint before the PATCH.
    const locked = lockedStatus === "locked";
    if (locked !== app.locked) {
      const result = await setLocked.mutateAsync({
        appId: app.id,
        locked,
      });
      if (!result) return;
    }
    // Visibility is editable on its own permissions; identity + environment only
    // when the caller can update the app, so omit those fields otherwise (mirrors
    // the field-limited bodies the old publish popover / rename dialog sent).
    // "Shared with named people" is stored as a personal app plus grants, so the
    // fourth option collapses back to `personal` here. Both lists are always
    // sent: switching away from Teams or Users must revoke what it left behind,
    // not strand it.
    const body: archestraApiTypes.UpdateAppData["body"] = {
      scope: scope === "user" ? "personal" : scope,
      teamIds: scope === "team" ? teamIds : [],
      userIds: scope === "user" ? userIds : [],
    };
    if (canUpdate) {
      body.name = values.name.trim();
      body.description = values.description.trim() || null;
      body.icon = values.icon;
      body.environmentId = environmentId;
      body.openInFullscreen = openMode === "fullscreen";
      // Flush a label typed into the picker but not yet committed, so a save
      // doesn't silently drop it.
      const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;
      body.labels = finalLabels.map(({ key, value }) => ({ key, value }));
      // Sent only when it actually changed, so a save that touches other fields
      // never re-sends the slug and 409s against the app's own row. Blank is
      // "leave it alone", not "clear it" — there is no way to unset a URL.
      const slug = values.slug.trim();
      if (slug !== "" && slug !== app.slug) {
        body.slug = slug;
      }
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
            <IdentityFields
              icon={form.watch("icon")}
              onIconChange={(icon) =>
                form.setValue("icon", icon, { shouldDirty: true })
              }
              fallbackType="app"
            >
              <div className="space-y-2">
                <Label htmlFor="app-settings-name">Name *</Label>
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
            </IdentityFields>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="app-settings-slug">URL</Label>
              <div className="flex items-center gap-1">
                <span className="shrink-0 text-sm text-muted-foreground">
                  /a/
                </span>
                <Input
                  id="app-settings-slug"
                  placeholder="sales-dashboard"
                  aria-invalid={!!form.formState.errors.slug}
                  // Only one of the two is rendered at a time, so point at
                  // whichever is actually in the DOM or the message goes
                  // unannounced (same wiring as components/ui/form.tsx).
                  aria-describedby={
                    form.formState.errors.slug
                      ? "app-settings-slug-error"
                      : "app-settings-slug-help"
                  }
                  {...form.register("slug", {
                    maxLength: {
                      value: 100,
                      message: "URL must be 100 characters or fewer.",
                    },
                    validate: (value) =>
                      value.trim() === "" ||
                      SLUG_PATTERN.test(value.trim()) ||
                      "Use lowercase letters, numbers and single hyphens.",
                  })}
                />
              </div>
              {form.formState.errors.slug?.message ? (
                <p
                  id="app-settings-slug-error"
                  className="text-xs text-destructive"
                >
                  {form.formState.errors.slug.message}
                </p>
              ) : (
                <p
                  id="app-settings-slug-help"
                  className="text-xs text-muted-foreground"
                >
                  Where this app opens. Changing it breaks links that used the
                  old URL.
                </p>
              )}
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

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="app-settings-open-mode">Opens in</Label>
              <Select
                value={openMode}
                onValueChange={(next) =>
                  setOpenMode(next as "inline" | "fullscreen")
                }
              >
                <SelectTrigger id="app-settings-open-mode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  {openModeOptions.map((option) => (
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
              {selectedOpenModeDescription ? (
                <p className="text-xs text-muted-foreground">
                  {selectedOpenModeDescription}
                </p>
              ) : null}
            </div>

            <ProfileLabels
              ref={labelsRef}
              labels={labels}
              onLabelsChange={setLabels}
            />
          </>
        )}

        <VisibilitySelector
          heading="Who can use this app"
          value={scope}
          options={options}
          onValueChange={setScope}
        >
          {scope === "user" && (
            <div className="space-y-2">
              <Label>Users</Label>
              <UserSearchableMultiSelect
                value={userIds}
                onValueChange={setUserIds}
                users={memberOptions}
                placeholder="Select users"
                searchPlaceholder="Search users..."
                emptyMessage="No users found."
                className="w-full"
              />
            </div>
          )}

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

          <div className="space-y-2">
            <Label>Modification</Label>
            <Select
              value={lockedStatus}
              onValueChange={(next) =>
                setLockedStatus(next as "unlocked" | "locked")
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {lockedOptions.map((option) => (
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
            {selectedLockedDescription ? (
              <p className="text-xs text-muted-foreground">
                {selectedLockedDescription}
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
              helpText="The app can be assigned and call MCP tools from this environment plus the Default environment."
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
