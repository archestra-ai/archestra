"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { AgentIcon } from "@/components/agent-icon";
import { projectVisibilityToScope } from "@/components/projects/project-visibility";
import { ScopeBadge } from "@/components/scope-badge";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { canManageProject } from "@/lib/projects/project-permissions";

type ProjectListItem = archestraApiTypes.GetProjectsResponses["200"][number];

// Table variant of one projects section (the caller keeps the same Pinned /
// All projects grouping as the card view). Mirrors the card actions:
// pin/unpin, edit details, delete.
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
  const router = useRouter();
  const { data: isProjectAdmin } = useHasPermissions({ project: ["admin"] });

  const columns: ColumnDef<ProjectListItem>[] = [
    {
      id: "name",
      accessorKey: "name",
      header: "Project",
      size: 700,
      cell: ({ row }) => {
        const project = row.original;
        return (
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0">
                <AgentIcon
                  icon={project.icon}
                  fallbackType="project"
                  size={16}
                />
              </span>
              <span className="truncate font-medium">{project.name}</span>
            </div>
            {project.description && (
              <div className="truncate text-xs text-muted-foreground">
                {project.description}
              </div>
            )}
          </div>
        );
      },
    },
    {
      id: "sharing",
      size: 200,
      header: "Sharing",
      cell: ({ row }) => {
        const project = row.original;
        return (
          <span className="flex flex-wrap items-center gap-1">
            <ScopeBadge
              scope={projectVisibilityToScope(project.visibility)}
              teamNames={project.shareTeamNames}
            />
            {project.viewerRole === "admin" && project.visibility === null && (
              <Badge variant="secondary">
                {project.ownerName
                  ? `Owned by ${project.ownerName}`
                  : "Other user"}
              </Badge>
            )}
          </span>
        );
      },
    },
    {
      id: "actions",
      size: 140,
      header: () => <div className="text-right">Actions</div>,
      cell: ({ row }) => {
        const project = row.original;
        const canPin = project.viewerRole !== "admin";
        const canManage = canManageProject(
          project.viewerRole,
          !!isProjectAdmin,
        );
        const actions: TableRowAction[] = [
          ...(canPin
            ? [
                {
                  icon: project.pinnedAt ? (
                    <PinOff className="h-4 w-4" />
                  ) : (
                    <Pin className="h-4 w-4" />
                  ),
                  label: project.pinnedAt ? "Unpin" : "Pin",
                  onClick: () => onTogglePin(project),
                } satisfies TableRowAction,
              ]
            : []),
          ...(canManage
            ? [
                {
                  icon: <Pencil className="h-4 w-4" />,
                  label: "Edit details",
                  onClick: () => onEdit(project),
                } satisfies TableRowAction,
                {
                  icon: <Trash2 className="h-4 w-4" />,
                  label: "Delete",
                  variant: "destructive",
                  onClick: () => onDelete(project),
                } satisfies TableRowAction,
              ]
            : []),
        ];
        if (actions.length === 0) return null;
        return (
          <div className="flex justify-end">
            <TableRowActions actions={actions} />
          </div>
        );
      },
    },
  ];

  return (
    <DataTable
      columns={columns}
      data={projects}
      getRowId={(row) => row.id}
      onRowClick={(row) => router.push(`/projects/${row.id}`)}
      emptyMessage="No projects yet"
      hidePaginationWhenSinglePage
    />
  );
}
