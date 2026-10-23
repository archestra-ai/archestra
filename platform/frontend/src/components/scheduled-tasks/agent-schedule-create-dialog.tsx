"use client";

import { useState } from "react";
import { ScheduleDialog } from "@/components/scheduled-tasks/schedule-dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateProject, useProjects } from "@/lib/projects/projects.query";
import type { ScheduleTrigger } from "@/lib/schedule-trigger.query";

const AUTO_PROJECT = "__create_project__";

export function AgentScheduleCreateDialog({
  agentId,
  agentName,
  open,
  onOpenChange,
  onCreated,
}: {
  agentId: string;
  agentName: string;
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onCreated: (schedule: ScheduleTrigger) => void;
}) {
  const [projectId, setProjectId] = useState(AUTO_PROJECT);
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  const projects = useProjects({ enabled: open, limit: 100 });
  const createProject = useCreateProject();
  const projectName = `${agentName} schedules`;
  const resolveProjectId = async () => {
    if (projectId !== AUTO_PROJECT) return projectId;
    if (createdProjectId) return createdProjectId;
    const project = await createProject.mutateAsync({
      name: projectName,
      defaultAgentId: agentId,
    });
    if (!project)
      throw new Error("The project couldn’t be created. Try again.");
    setCreatedProjectId(project.id);
    return project.id;
  };
  return (
    <ScheduleDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create schedule"
      description="Run this agent on a recurring schedule."
      submitLabel="Create schedule"
      fixedAgent={{ id: agentId, name: agentName }}
      initialValues={{
        enabled: true,
        cronExpression: "0 9 * * *",
        timezone: "America/Toronto",
      }}
      resolveProjectId={resolveProjectId}
      onSaved={onCreated}
      projectField={
        <div className="space-y-1.5">
          <Label htmlFor="agent-schedule-project">Project</Label>
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger id="agent-schedule-project" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO_PROJECT}>Create automatically</SelectItem>
              {(projects.data?.data ?? []).map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {projectId === AUTO_PROJECT && (
            <p className="text-xs text-muted-foreground">
              {createdProjectId
                ? `This schedule will use the “${projectName}” project created for it.`
                : `A project named “${projectName}” will be created when you create this schedule.`}
            </p>
          )}
        </div>
      }
    />
  );
}
