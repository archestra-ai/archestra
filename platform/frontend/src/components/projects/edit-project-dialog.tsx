"use client";

import {
  type archestraApiTypes,
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
} from "@archestra/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import { AgentIcon } from "@/components/agent-icon";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import { AgentSelector } from "@/components/agent-selector";
import { IdentityFields } from "@/components/identity-fields";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useInternalAgents } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  agentsForProjectAudience,
  type ProjectShareAudience,
} from "@/lib/projects/project-agent-audience";
import { useProject, useUpdateProject } from "@/lib/projects/projects.query";

type ProjectDialogSection = "general" | "permissions";
type EditProjectForm = {
  name: string;
  description: string;
  icon: string | null;
  defaultAgentId: string | null;
};

/** Sentinel for "no pinned agent" — the picker cannot hold an empty value. */
const NO_DEFAULT_AGENT = "__org_default__";

/**
 * Single edit entry point for a project's owner/admin: its identity and default
 * agent on one page, who can reach it on another. Fetches the project detail by
 * id so it works from the projects list (whose rows lack the default agent) as
 * well as the project page. Renders nothing until the detail has loaded.
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

/**
 * A dialog page. The inactive one is hidden rather than unmounted:
 * react-hook-form skips validation for fields that are not mounted, so
 * unmounting General would let a rejected name reach the update route as soon
 * as the user switched pages.
 */
function DialogSection({
  id,
  activeSection,
  children,
}: {
  id: ProjectDialogSection;
  activeSection: ProjectDialogSection;
  children: React.ReactNode;
}) {
  return (
    <div hidden={id !== activeSection} className="space-y-4">
      {children}
    </div>
  );
}

const NAV_ITEMS = [
  { id: "general" as const, label: "General" },
  { id: "permissions" as const, label: "Permissions" },
];

function EditProjectDialogForm({
  project,
  open,
  onOpenChange,
}: {
  project: archestraApiTypes.GetProjectResponses["200"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [activeSection, setActiveSection] =
    useState<ProjectDialogSection>("general");
  const updateProject = useUpdateProject();
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
  const [labels, setLabels] = useState<ProfileLabel[]>(project.labels);
  const labelsRef = useRef<ProfileLabelsRef>(null);

  // Who the project reaches is edited on the Permissions page, which saves
  // itself — so the agent offer is judged against the sharing on record.
  const share: ProjectShareAudience = useMemo(
    () => ({
      visibility: project.visibility ?? "none",
      teamIds: project.shareTeamIds ?? [],
      userIds: project.shareUserIds ?? [],
    }),
    [project.visibility, project.shareTeamIds, project.shareUserIds],
  );
  const editorIsOwner = project.viewerRole === "owner";
  const selectableAgents = useMemo(
    () => agentsForProjectAudience(accessibleAgents, { share, editorIsOwner }),
    [accessibleAgents, share, editorIsOwner],
  );

  // A pinned agent the audience cannot run is no longer a valid choice. Fall
  // back to the organization default rather than leave a selection the save
  // would reject.
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

  const hasLengthError =
    name.length > PROJECT_NAME_MAX_LENGTH ||
    description.length > PROJECT_DESCRIPTION_MAX_LENGTH;

  const onSubmit = form.handleSubmit(
    async ({ name, description, icon, defaultAgentId }) => {
      const nextLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;

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
        labels: nextLabels,
      });
      if (!ok) return;

      onOpenChange(false);
    },
  );

  return (
    <TabbedDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Edit project"
      description={`Update "${project.name}" and who can reach it.`}
      sidebarLabel={name.trim() || project.name}
      sidebarDescription="Project"
      sidebarIcon={<AgentIcon icon={icon} fallbackType="project" size={16} />}
      activeSection={activeSection}
      navItems={NAV_ITEMS}
      onActiveSectionChange={setActiveSection}
      onSubmit={onSubmit}
      className="max-w-4xl h-[70vh]"
      footer={
        // Permissions saves itself, so the form's own Save would only be a
        // second button doing something else on the page it sits under.
        activeSection === "permissions" ? (
          <Button type="button" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                updateProject.isPending || !name.trim().length || hasLengthError
              }
            >
              Save
            </Button>
          </>
        )
      }
    >
      <DialogSection id="general" activeSection={activeSection}>
        <IdentityFields
          icon={icon}
          onIconChange={(next) =>
            form.setValue("icon", next, { shouldDirty: true })
          }
          fallbackType="project"
          label={<Label htmlFor="edit-project-name">Name *</Label>}
        >
          <Input
            id="edit-project-name"
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
        </IdentityFields>

        <div className="space-y-2">
          <Label htmlFor="edit-project-description">Description</Label>
          <Textarea
            id="edit-project-description"
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

        {canReadAgents === true && (
          <div className="space-y-2">
            <Label>Default agent</Label>
            <FieldDescription>
              Preselected for new chats and scheduled tasks in this project.
              Anyone can still pick a different agent for an individual chat.
            </FieldDescription>
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
              hint={audienceHint(share.visibility)}
              emptyMessage="No agents this project's members can all use."
              sentinelOption={{
                value: NO_DEFAULT_AGENT,
                label: "Default",
              }}
              className="w-full"
            />
          </div>
        )}

        <AdvancedLabelsSection
          ref={labelsRef}
          labels={labels}
          onLabelsChange={setLabels}
        />
      </DialogSection>

      <DialogSection id="permissions" activeSection={activeSection}>
        <ResourceAccessSection resource="project" id={project.id} />
      </DialogSection>
    </TabbedDialogShell>
  );
}

/** Says why the list is what it is, so a short list doesn't read as a bug. */
function audienceHint(visibility: ProjectShareAudience["visibility"]): string {
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
