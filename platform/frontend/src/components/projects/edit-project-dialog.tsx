"use client";

import {
  type archestraApiTypes,
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
} from "@archestra/shared";
import { Globe, Lock, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { AgentIconPicker } from "@/components/agent-icon-picker";
import { AgentSelector } from "@/components/agent-selector";
import { StandardFormDialog } from "@/components/standard-dialog";
import { AssignmentCombobox } from "@/components/ui/assignment-combobox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { hasUnsavedChanges } from "@/components/unsaved-changes-guard-utils";
import {
  UserShareField,
  useUserShareOption,
} from "@/components/user-share-field";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { useInternalAgents } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { agentsForProjectAudience } from "@/lib/projects/project-agent-audience";
import {
  useProject,
  useSetProjectShare,
  useUpdateProject,
} from "@/lib/projects/projects.query";
import { useTeams } from "@/lib/teams/team.query";

type ProjectVisibility = "none" | "organization" | "team" | "user";
type EditProjectForm = {
  name: string;
  description: string;
  icon: string | null;
  defaultAgentId: string | null;
};

/** Sentinel for "no pinned agent" — the picker cannot hold an empty value. */
const NO_DEFAULT_AGENT = "__org_default__";

/**
 * Single edit entry point for a project's owner/admin: name, description, icon,
 * and default agent plus the shared visibility control. Fetches the project
 * detail by id so it works from the projects list (whose rows lack share team
 * ids) as well as the project page. Renders nothing until the detail has loaded.
 */
export function EditProjectDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: project } = useProject(open ? projectId : undefined);
  if (!project) return null;
  return (
    <EditProjectDialogForm
      key={project.id}
      project={project}
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}

// === internal ===

function EditProjectDialogForm({
  project,
  open,
  onOpenChange,
}: {
  project: archestraApiTypes.GetProjectResponses["200"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const updateProject = useUpdateProject();
  const setShare = useSetProjectShare();
  const { data: teams = [] } = useTeams({ enabled: open });
  const { data: canShareOrg } = useHasPermissions({ project: ["share-org"] });
  // Without `agent:read` the list comes back empty, which would read as "this
  // org has no agents" rather than "not yours to set" — hide the field instead.
  const { data: canReadAgents } = useHasPermissions({ agent: ["read"] });
  const { data: accessibleAgents = [], isPending: isAgentsPending } =
    useInternalAgents({
      enabled: open && canReadAgents === true,
    });

  const form = useForm<EditProjectForm>({
    defaultValues: {
      name: project.name,
      description: project.description ?? "",
      icon: project.icon,
      defaultAgentId: project.defaultAgent?.id ?? null,
    },
    mode: "onChange",
  });
  const icon = form.watch("icon");
  const name = form.watch("name");
  const description = form.watch("description");
  const defaultAgentId = form.watch("defaultAgentId");
  const initialVisibility: ProjectVisibility = project.visibility ?? "none";
  const [visibility, setVisibility] =
    useState<ProjectVisibility>(initialVisibility);
  const [teamIds, setTeamIds] = useState<string[]>(project.shareTeamIds ?? []);
  const [userIds, setUserIds] = useState<string[]>(project.shareUserIds ?? []);
  const userOption = useUserShareOption<ProjectVisibility>("user");

  // Sharing is edited in this same dialog, so the offer follows the pending
  // choice rather than what is saved — pick Teams and the list narrows before
  // you press Save.
  const editorIsOwner = project.viewerRole === "owner";
  const selectableAgents = useMemo(
    () =>
      agentsForProjectAudience(accessibleAgents, {
        share: { visibility, teamIds, userIds },
        editorIsOwner,
      }),
    [accessibleAgents, visibility, teamIds, userIds, editorIsOwner],
  );

  // Widening the audience can strand the pinned agent. Fall back to the
  // organization default rather than leave a selection the save would reject.
  useEffect(() => {
    // Every agent looks unreachable before the list arrives, which would clear
    // the project's saved pin the moment the dialog opened. `isPending` also
    // stays true while the query is disabled, so a hidden field never resets.
    if (isAgentsPending) return;
    // On someone else's project the offer is deliberately conservative (the
    // owner's reach is unknowable here), so absence from it is no evidence the
    // pin is broken. Resetting on that would let an admin fixing a typo wipe
    // the owner's choice.
    if (!editorIsOwner) return;
    if (!defaultAgentId) return;
    if (selectableAgents.some((agent) => agent.id === defaultAgentId)) return;
    form.setValue("defaultAgentId", null, { shouldDirty: true });
  }, [defaultAgentId, selectableAgents, isAgentsPending, editorIsOwner, form]);

  // Org-wide sharing (both entering and leaving it) is gated behind
  // `project:share-org` on the backend; mirror that here so the dialog doesn't
  // offer changes the save would reject.
  const shareLocked = initialVisibility === "organization" && !canShareOrg;

  const visibilityOptions: Array<VisibilityOption<ProjectVisibility>> = [
    {
      value: "none",
      label: "Personal",
      description: "No one else can see this project.",
      icon: Lock,
      disabled: shareLocked,
    },
    {
      value: "organization",
      label: "Organization",
      description: "Everyone in your organization can see this project.",
      icon: Globe,
      disabled: !canShareOrg,
      disabledLabel: !canShareOrg ? "Requires permission" : undefined,
      disabledReason: !canShareOrg
        ? "You don't have permission to share projects with the entire organization."
        : undefined,
    },
    { ...userOption, disabled: shareLocked || userOption.disabled },
    {
      value: "team",
      label: "Teams",
      description: "Share this project with selected teams.",
      icon: Users,
      disabled: shareLocked || teams.length === 0,
      disabledLabel:
        !shareLocked && teams.length === 0 ? "No teams available" : undefined,
    },
  ];

  const isPending = updateProject.isPending || setShare.isPending;
  const sharingDirty =
    visibility !== initialVisibility ||
    (visibility === "team" &&
      hasUnsavedChanges(
        [...(project.shareTeamIds ?? [])].sort(),
        [...teamIds].sort(),
      )) ||
    (visibility === "user" &&
      hasUnsavedChanges(
        [...(project.shareUserIds ?? [])].sort(),
        [...userIds].sort(),
      ));
  const isDirty = form.formState.isDirty || sharingDirty;
  const teamSelectionMissing = visibility === "team" && teamIds.length === 0;
  // Same guard as Teams: saving Users with nobody picked would quietly make the
  // project private again.
  const userSelectionMissing = visibility === "user" && userIds.length === 0;
  const hasLengthError =
    name.length > PROJECT_NAME_MAX_LENGTH ||
    description.length > PROJECT_DESCRIPTION_MAX_LENGTH;

  const onSubmit = form.handleSubmit(
    async ({ name, description, icon, defaultAgentId }) => {
      if (teamSelectionMissing || userSelectionMissing) return;

      const nextTeamIds = visibility === "team" ? teamIds : [];
      // Both lists are always sent, so leaving Teams or Users revokes what that
      // choice left behind instead of stranding it.
      const nextUserIds = visibility === "user" ? userIds : [];
      const shareChanged =
        visibility !== initialVisibility ||
        (visibility === "team" &&
          nextTeamIds.slice().sort().join() !==
            (project.shareTeamIds ?? []).slice().sort().join()) ||
        (visibility === "user" &&
          nextUserIds.slice().sort().join() !==
            (project.shareUserIds ?? []).slice().sort().join());
      // Sharing goes first: the default agent is picked against the sharing
      // chosen here, and the server judges it against the sharing on record.
      // Saving the agent first would validate it against the old audience and
      // reject a choice this dialog legitimately offered.
      if (shareChanged) {
        const shareOk = await setShare.mutateAsync({
          id: project.id,
          visibility,
          teamIds: nextTeamIds,
          userIds: nextUserIds,
        });
        if (!shareOk) return;
      }

      const ok = await updateProject.mutateAsync({
        id: project.id,
        name: name.trim(),
        description: description.trim() || null,
        icon,
        // Sent only when actually changed. The value here is whatever was
        // loaded when the dialog opened, so sending it unconditionally would
        // revert a default another admin set in the meantime.
        ...(form.formState.dirtyFields.defaultAgentId
          ? { defaultAgentId }
          : {}),
      });
      if (!ok) return;

      onOpenChange(false);
    },
  );

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit project"
      size="medium"
      isDirty={isDirty}
      onSubmit={onSubmit}
      bodyClassName="space-y-4"
      footer={
        <>
          <DialogCancelButton disabled={isPending}>Cancel</DialogCancelButton>
          <Button
            type="submit"
            disabled={
              isPending ||
              !name.trim().length ||
              hasLengthError ||
              teamSelectionMissing ||
              userSelectionMissing
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-3">
        <AgentIconPicker
          value={icon}
          onChange={(next) =>
            form.setValue("icon", next, { shouldDirty: true })
          }
          fallbackType="project"
        />
        <div className="flex-1 space-y-3 min-w-0">
          <Input
            aria-label="Project name"
            placeholder="Project name"
            maxLength={PROJECT_NAME_MAX_LENGTH}
            aria-invalid={!!form.formState.errors.name}
            {...form.register("name", {
              required: "Project name is required.",
              maxLength: {
                value: PROJECT_NAME_MAX_LENGTH,
                message: `Project name must be ${PROJECT_NAME_MAX_LENGTH} characters or fewer.`,
              },
            })}
          />
          {form.formState.errors.name?.message && (
            <p className="text-xs text-destructive">
              {form.formState.errors.name.message}
            </p>
          )}
          <Textarea
            aria-label="Project description"
            placeholder="What is this project about?"
            rows={3}
            maxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
            aria-invalid={!!form.formState.errors.description}
            {...form.register("description", {
              maxLength: {
                value: PROJECT_DESCRIPTION_MAX_LENGTH,
                message: `Description must be ${PROJECT_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
              },
            })}
          />
          {form.formState.errors.description?.message && (
            <p className="text-xs text-destructive">
              {form.formState.errors.description.message}
            </p>
          )}
        </div>
      </div>

      <VisibilitySelector
        heading="Sharing"
        value={visibility}
        options={visibilityOptions}
        onValueChange={setVisibility}
        readOnly={shareLocked}
      >
        {visibility === "user" && (
          <UserShareField value={userIds} onValueChange={setUserIds} />
        )}

        {visibility === "team" && (
          <div className="space-y-2">
            <Label>Teams</Label>
            <AssignmentCombobox
              items={teams.map((team) => ({ id: team.id, name: team.name }))}
              selectedIds={teamIds}
              onToggle={(teamId) =>
                setTeamIds((current) =>
                  current.includes(teamId)
                    ? current.filter((id) => id !== teamId)
                    : [...current, teamId],
                )
              }
              label="Select teams"
              placeholder="Search teams..."
              emptyMessage="No teams found."
              className="h-9 w-full justify-between border text-sm text-foreground"
            />
            {teamIds.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {teams
                  .filter((team) => teamIds.includes(team.id))
                  .map((team) => (
                    <Badge key={team.id} variant="secondary">
                      {team.name}
                    </Badge>
                  ))}
              </div>
            )}
          </div>
        )}
      </VisibilitySelector>

      {shareLocked && (
        <p className="text-xs text-muted-foreground">
          This project is shared with the entire organization. Changing its
          sharing requires the org-wide sharing permission.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        People you share with can read every chat, start their own, and work
        with the project's files through chats.
      </p>

      {canReadAgents === true && (
        <div className="space-y-1.5">
          <Label>Default agent</Label>
          <AgentSelector
            mode="single"
            agents={selectableAgents}
            value={defaultAgentId ?? NO_DEFAULT_AGENT}
            onValueChange={(value) =>
              form.setValue(
                "defaultAgentId",
                value === NO_DEFAULT_AGENT ? null : value,
                { shouldDirty: true },
              )
            }
            hint={audienceHint(visibility)}
            emptyMessage="No agents this project's members can all use."
            personalDefaultOption={{
              value: NO_DEFAULT_AGENT,
              label: "Default",
            }}
            className="w-full"
          />
          <p className="text-xs text-muted-foreground">
            Preselected for new chats and scheduled tasks in this project.
            Anyone can still pick a different agent for an individual chat.
          </p>
        </div>
      )}
    </StandardFormDialog>
  );
}

/** Says why the list is what it is, so a short list doesn't read as a bug. */
function audienceHint(visibility: ProjectVisibility): string {
  switch (visibility) {
    case "organization":
      return "Only org-wide agents, so everyone can use them";
    case "team":
      return "Only agents assigned to every selected team";
    case "user":
      return "Only agents everyone you share with can use";
    default:
      return "Any agent you can use";
  }
}
