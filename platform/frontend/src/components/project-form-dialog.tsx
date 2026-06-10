"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { Globe, User, Users } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { AgentIconPicker } from "@/components/agent-icon-picker";
import { KnowledgeSourcesSelector } from "@/components/knowledge-sources-selector";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { Textarea } from "@/components/ui/textarea";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useKnowledgeBases } from "@/lib/knowledge/knowledge-base.query";
import {
  type Project,
  useCreateProject,
  useUpdateProject,
} from "@/lib/project.query";
import { useTeams } from "@/lib/teams/team.query";

export function ProjectFormDialog({
  open,
  onOpenChange,
  project,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project?: Project | null;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [instructions, setInstructions] = useState("");
  const [scope, setScope] = useState<ResourceVisibilityScope>("personal");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState<string[]>([]);
  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const { data: canProjectAdmin } = useHasPermissions({ project: ["admin"] });
  const { data: canProjectTeamAdmin } = useHasPermissions({
    project: ["team-admin"],
  });
  const { data: teams = [] } = useTeams({
    enabled: !!canProjectAdmin || !!canProjectTeamAdmin,
  });
  const { data: knowledgeBasesData } = useKnowledgeBases();
  const knowledgeBases = knowledgeBasesData ?? [];

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? "");
    setDescription(project?.description ?? "");
    setIcon(project?.icon ?? null);
    setInstructions(project?.instructions ?? "");
    setScope(project?.scope ?? "personal");
    setTeamIds(project?.teams.map((team) => team.id) ?? []);
    setKnowledgeBaseIds(project?.knowledgeBaseIds ?? []);
  }, [open, project]);

  const isPending = createProject.isPending || updateProject.isPending;
  const canShareWithTeams = !!canProjectAdmin || !!canProjectTeamAdmin;
  const hasNoTeams = teams.length === 0;
  const options: VisibilityOption<ResourceVisibilityScope>[] = [
    {
      value: "personal",
      label: "Personal",
      description: "Only you can use this project",
      icon: User,
    },
    {
      value: "team",
      label: "Teams",
      description: "Share this project with selected teams",
      icon: Users,
      disabled: scope !== "team" && (!canShareWithTeams || hasNoTeams),
      disabledReason: !canShareWithTeams
        ? "You need project:team-admin permission to share projects with teams"
        : hasNoTeams
          ? "No teams are available"
          : undefined,
    },
    {
      value: "org",
      label: "Organization",
      description: "Anyone in your org can use this project",
      icon: Globe,
      disabled: scope !== "org" && !canProjectAdmin,
      disabledReason: !canProjectAdmin
        ? "You need project:admin permission to share projects"
        : undefined,
    },
  ];

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload = {
      name,
      description: description || null,
      icon,
      instructions: instructions || null,
      scope,
      teamIds: scope === "team" ? teamIds : [],
      knowledgeBaseIds,
    };
    const result = project
      ? await updateProject.mutateAsync({ id: project.id, ...payload })
      : await createProject.mutateAsync(payload);
    if (result) onOpenChange(false);
  };

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={project ? "Edit project" : "New project"}
      onSubmit={handleSubmit}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!name.trim() || isPending}>
            {project ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-start gap-4">
            <AgentIconPicker
              value={icon}
              onChange={setIcon}
              fallbackType="agent"
            />
            <div className="min-w-0 flex-1 space-y-2">
              <Label htmlFor="project-name">Name *</Label>
              <Input
                id="project-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Customer support triage"
                autoFocus
              />
              <div className="space-y-2 pt-2">
                <Label htmlFor="project-description">Description</Label>
                <Textarea
                  id="project-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="What is this project for?"
                  className="min-h-[70px]"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-4 space-y-4">
          <div className="space-y-2">
            <Label>Knowledge Sources</Label>
            <p className="text-xs text-muted-foreground">
              Choose which knowledge this project can draw from in chat.
            </p>
            <KnowledgeSourcesSelector
              knowledgeBases={knowledgeBases}
              selectedKnowledgeBaseIds={knowledgeBaseIds}
              onKnowledgeBaseIdsChange={setKnowledgeBaseIds}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-instructions">Instructions</Label>
            <Textarea
              id="project-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="How should agents behave in this project?"
              className="min-h-[120px]"
            />
          </div>
        </div>

        <div className="rounded-lg border bg-card p-4">
          <VisibilitySelector
            heading="Who can use this project"
            value={scope}
            options={options}
            onValueChange={setScope}
          >
            {scope === "team" && (
              <div className="space-y-2">
                <Label>Teams</Label>
                <MultiSelectCombobox
                  disabled={!canShareWithTeams || hasNoTeams}
                  options={teams.map((team) => ({
                    value: team.id,
                    label: team.name,
                  }))}
                  value={teamIds}
                  onChange={setTeamIds}
                  placeholder={
                    hasNoTeams ? "No teams available" : "Search teams..."
                  }
                  emptyMessage="No teams found."
                />
              </div>
            )}
          </VisibilitySelector>
        </div>
      </div>
    </StandardFormDialog>
  );
}
