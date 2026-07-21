"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Pin } from "lucide-react";
import Link from "next/link";
import { AgentIcon } from "@/components/agent-icon";
import { projectVisibilityToScope } from "@/components/projects/project-visibility";
import { ScopeBadge } from "@/components/scope-badge";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { canManageProject } from "@/lib/projects/project-permissions";
import { ProjectActionsMenu } from "./project-actions-menu";

type ProjectListItem = archestraApiTypes.GetProjectsResponses["200"][number];

// Table variant of the projects list: one flat table (pinned rows are already
// sorted first by the caller and get a pin marker instead of a section).
export function ProjectsTable({
  projects,
  onTogglePin,
  onEdit,
  onDelete,
}: {
  projects: ProjectListItem[];
  onTogglePin: (project: ProjectListItem) => void;
  onEdit: (project: ProjectListItem) => void;
  onDelete: (project: ProjectListItem) => void;
}) {
  const { data: isProjectAdmin } = useHasPermissions({ project: ["admin"] });

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[30%]">Name</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="w-[18%]">Sharing</TableHead>
            <TableHead className="w-12" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.map((project) => (
            <TableRow key={project.id}>
              <TableCell>
                <Link
                  href={`/projects/${project.id}`}
                  className="flex min-w-0 items-center gap-2 hover:underline"
                >
                  <span className="shrink-0">
                    <AgentIcon
                      icon={project.icon}
                      fallbackType="project"
                      size={18}
                    />
                  </span>
                  <span className="min-w-0 truncate font-medium">
                    {project.name}
                  </span>
                  {project.pinnedAt && (
                    <Pin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                </Link>
              </TableCell>
              <TableCell>
                <span className="line-clamp-2 text-muted-foreground">
                  {project.description}
                </span>
              </TableCell>
              <TableCell>
                <span className="flex flex-wrap items-center gap-1">
                  <ScopeBadge
                    scope={projectVisibilityToScope(project.visibility)}
                    teamNames={project.shareTeamNames}
                  />
                  {project.viewerRole === "admin" &&
                    project.visibility === null && (
                      <Badge variant="secondary">
                        {project.ownerName
                          ? `Owned by ${project.ownerName}`
                          : "Other user"}
                      </Badge>
                    )}
                </span>
              </TableCell>
              <TableCell className="text-right">
                <ProjectActionsMenu
                  pinned={!!project.pinnedAt}
                  canPin={project.viewerRole !== "admin"}
                  canManage={canManageProject(
                    project.viewerRole,
                    !!isProjectAdmin,
                  )}
                  onTogglePin={() => onTogglePin(project)}
                  onEdit={() => onEdit(project)}
                  onDelete={() => onDelete(project)}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
