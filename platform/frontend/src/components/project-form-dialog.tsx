"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { Globe, User, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { AgentIcon } from "@/components/agent-icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  const [icon, setIcon] = useState("");
  const [instructions, setInstructions] = useState("");
  const [scope, setScope] = useState<ResourceVisibilityScope>("personal");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState<string[]>([]);
  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const { data: canProjectAdmin } = useHasPermissions({ project: ["admin"] });
  const { data: teams = [] } = useTeams({ enabled: !!canProjectAdmin });
  const { data: knowledgeBasesData } = useKnowledgeBases();
  const knowledgeBases = knowledgeBasesData ?? [];

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? "");
    setDescription(project?.description ?? "");
    setIcon(project?.icon ?? "");
    setInstructions(project?.instructions ?? "");
    setScope(project?.scope ?? "personal");
    setTeamIds(project?.teams.map((team) => team.id) ?? []);
    setKnowledgeBaseIds(project?.knowledgeBaseIds ?? []);
  }, [open, project]);

  const isPending = createProject.isPending || updateProject.isPending;
  const canShare = !!canProjectAdmin;
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
      disabled: scope !== "team" && (!canShare || hasNoTeams),
      disabledReason: !canShare
        ? "You need project:admin permission to share projects"
        : hasNoTeams
          ? "No teams are available"
          : undefined,
    },
    {
      value: "org",
      label: "Organization",
      description: "Anyone in your org can use this project",
      icon: Globe,
      disabled: scope !== "org" && !canShare,
      disabledReason: !canShare
        ? "You need project:admin permission to share projects"
        : undefined,
    },
  ];

  const handleSubmit = async () => {
    const payload = {
      name,
      description: description || null,
      icon: icon || null,
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{project ? "Edit project" : "New project"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid grid-cols-[72px_1fr] gap-3">
            <div className="space-y-2">
              <Label>Icon</Label>
              <div className="flex h-10 items-center justify-center rounded-md border">
                <AgentIcon icon={icon || null} fallbackType="agent" size={18} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Icon</Label>
            <Input
              value={icon}
              onChange={(event) => setIcon(event.target.value)}
              placeholder="Emoji, letter, or data URL"
            />
          </div>
          <div className="space-y-2">
            <Label>Knowledge sources</Label>
            <MultiSelectCombobox
              options={knowledgeBases.map((knowledgeBase) => ({
                value: knowledgeBase.id,
                label: knowledgeBase.name,
              }))}
              value={knowledgeBaseIds}
              onChange={setKnowledgeBaseIds}
              placeholder="Search knowledge sources..."
              emptyMessage="No knowledge sources found."
            />
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
            />
          </div>
          <div className="space-y-2">
            <Label>Instructions</Label>
            <Textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              rows={5}
            />
          </div>
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
                  disabled={!canShare || hasNoTeams}
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
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || isPending} onClick={handleSubmit}>
            {project ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
