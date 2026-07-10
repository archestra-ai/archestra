"use client";

import {
  type archestraApiTypes,
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
} from "@archestra/shared";
import { Globe, Lock, Users } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { AgentIconPicker } from "@/components/agent-icon-picker";
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
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import {
  useProject,
  useSetProjectShare,
  useUpdateProject,
} from "@/lib/projects/projects.query";
import { useTeams } from "@/lib/teams/team.query";

type ProjectVisibility = "none" | "organization" | "team";
type EditProjectForm = {
  name: string;
  description: string;
  icon: string | null;
};

/**
 * Single edit entry point for a project's owner/admin: name, description, and
 * icon plus the shared visibility control. Fetches the project detail by id so
 * it works from the projects list (whose rows lack share team ids) as well as
 * the project page. Renders nothing until the detail has loaded.
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

  const form = useForm<EditProjectForm>({
    defaultValues: {
      name: project.name,
      description: project.description ?? "",
      icon: project.icon,
    },
    mode: "onChange",
  });
  const icon = form.watch("icon");
  const name = form.watch("name");
  const description = form.watch("description");
  const initialVisibility: ProjectVisibility = project.visibility ?? "none";
  const [visibility, setVisibility] =
    useState<ProjectVisibility>(initialVisibility);
  const [teamIds, setTeamIds] = useState<string[]>(project.shareTeamIds ?? []);

  const visibilityOptions: Array<VisibilityOption<ProjectVisibility>> = [
    {
      value: "none",
      label: "Only me",
      description: "No one else can see this project.",
      icon: Lock,
    },
    {
      value: "organization",
      label: "Organization",
      description: "Everyone in your organization can see this project.",
      icon: Globe,
    },
    {
      value: "team",
      label: "Teams",
      description: "Share this project with selected teams.",
      icon: Users,
      disabled: teams.length === 0,
      disabledLabel: teams.length === 0 ? "No teams available" : undefined,
    },
  ];

  const isPending = updateProject.isPending || setShare.isPending;
  const sharingDirty =
    visibility !== initialVisibility ||
    (visibility === "team" &&
      hasUnsavedChanges(
        [...(project.shareTeamIds ?? [])].sort(),
        [...teamIds].sort(),
      ));
  const isDirty = form.formState.isDirty || sharingDirty;
  const teamSelectionMissing = visibility === "team" && teamIds.length === 0;
  const hasLengthError =
    name.length > PROJECT_NAME_MAX_LENGTH ||
    description.length > PROJECT_DESCRIPTION_MAX_LENGTH;

  const onSubmit = form.handleSubmit(async ({ name, description, icon }) => {
    if (teamSelectionMissing) return;
    const ok = await updateProject.mutateAsync({
      id: project.id,
      name: name.trim(),
      description: description.trim() || null,
      icon,
    });
    if (!ok) return;

    const nextTeamIds = visibility === "team" ? teamIds : [];
    const shareChanged =
      visibility !== initialVisibility ||
      (visibility === "team" &&
        nextTeamIds.slice().sort().join() !==
          (project.shareTeamIds ?? []).slice().sort().join());
    if (shareChanged) {
      const shareOk = await setShare.mutateAsync({
        id: project.id,
        visibility,
        teamIds: nextTeamIds,
      });
      if (!shareOk) return;
    }
    onOpenChange(false);
  });

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
              teamSelectionMissing
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
      >
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

      <p className="text-xs text-muted-foreground">
        People you share with can read every chat, start their own, and work
        with the project's files through chats.
      </p>
    </StandardFormDialog>
  );
}
