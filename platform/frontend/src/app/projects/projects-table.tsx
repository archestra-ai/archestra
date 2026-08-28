"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type {
  ColumnDef,
  OnChangeFn,
  RowSelectionState,
} from "@tanstack/react-table";
import {
  ArchiveRestore,
  FolderKanban,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { AgentIcon } from "@/components/agent-icon";
import { permanentDeleteRowAction } from "@/components/permanent-delete";
import { projectVisibilityToScope } from "@/components/projects/project-visibility";
import { ScopeBadge } from "@/components/scope-badge";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { DataTable } from "@/components/ui/data-table";
import { useHasPermissions } from "@/lib/auth/auth.query";
import type { BulkRangeSelectionController } from "@/lib/bulk-range-selection";
import { useIsGlobalAdmin } from "@/lib/organization.query";
import {
  canDeleteProject,
  canManageProject,
} from "@/lib/projects/project-permissions";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

type ProjectListItem = archestraApiTypes.GetProjectsResponses["200"][number];

// Table variant of one projects section (the caller keeps the same Pinned /
// All projects grouping as the card view). Mirrors the card actions:
// pin/unpin, edit details, delete.
export function ProjectsTable({
  projects,
  onTogglePin,
  onEdit,
  onDelete,
  rowSelection,
  onRowSelectionChange,
  onPageRowIdsChange,
  canSelect,
  rangeSelection,
}: {
  projects: ProjectListItem[];
  onTogglePin: (project: ProjectListItem) => void;
  onEdit: (project: ProjectListItem) => void;
  onDelete: (project: ProjectListItem) => void;
  rowSelection: RowSelectionState;
  onRowSelectionChange: OnChangeFn<RowSelectionState>;
  onPageRowIdsChange: (ids: string[]) => void;
  canSelect: (project: ProjectListItem) => boolean;
  rangeSelection: BulkRangeSelectionController;
}) {
  const router = useRouter();
  const { data: isProjectAdmin } = useHasPermissions({ project: ["admin"] });
  const { data: canShareOrg } = useHasPermissions({ project: ["share-org"] });

  const columns: ColumnDef<ProjectListItem>[] = [
    createSelectColumn<ProjectListItem>({
      rowLabel: (project) => `Select ${project.name}`,
      allLabel: "Select all projects on this page",
      canSelect,
      disabledReason: () => "You cannot modify this project",
    }),
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
              userNames={project.shareUserNames}
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
        const canDelete = canDeleteProject({
          viewerRole: project.viewerRole,
          visibility: project.visibility,
          isProjectAdmin: !!isProjectAdmin,
          canShareOrg: !!canShareOrg,
        });
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
              ]
            : []),
          ...(canManage && canDelete
            ? [
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
      rowSelection={rowSelection}
      onRowSelectionChange={onRowSelectionChange}
      onPageRowIdsChange={onPageRowIdsChange}
      rangeSelection={rangeSelection}
      hideSelectedCount
      onRowClick={(row) => router.push(`/projects/${row.id}`)}
      emptyIcon={FolderKanban}
      emptyMessage="No projects yet"
      hidePaginationWhenSinglePage
    />
  );
}

// The trash view: soft-deleted projects org-wide (the backend serves this slice
// to project admins only). Rows deliberately do not navigate — the project page
// would 404 on a deleted id — and the actions collapse to Restore + Delete
// permanently, matching the agents and skills trash views.
export function DeletedProjectsTable({
  projects,
  onRestore,
  onPermanentlyDelete,
}: {
  projects: ProjectListItem[];
  onRestore: (project: ProjectListItem) => void;
  onPermanentlyDelete: (project: ProjectListItem) => void;
}) {
  const admin = useIsGlobalAdmin();

  const columns: ColumnDef<ProjectListItem>[] = [
    {
      id: "name",
      accessorKey: "name",
      header: "Project",
      size: 560,
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
              {project.ownerName && (
                <Badge variant="secondary">Owned by {project.ownerName}</Badge>
              )}
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
      id: "deleted",
      size: 200,
      header: "Deleted",
      cell: ({ row }) => (
        <span className="text-sm">
          {formatRelativeTimeFromNow(row.original.deletedAt)}
        </span>
      ),
    },
    {
      id: "actions",
      size: 140,
      header: () => <div className="text-right">Actions</div>,
      cell: ({ row }) => (
        <div className="flex justify-end">
          <TableRowActions
            itemName={row.original.name}
            actions={[
              {
                icon: <ArchiveRestore className="h-4 w-4" />,
                label: "Restore",
                // The route gates restore on `project:admin`, not
                // `project:delete` — the same bar that serves this slice at
                // all. A lower one here would disable Restore for exactly the
                // oversight role the trash is built for.
                permissions: { project: ["admin"] },
                onClick: () => onRestore(row.original),
              },
              permanentDeleteRowAction({
                admin,
                onClick: () => onPermanentlyDelete(row.original),
              }),
            ]}
          />
        </div>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      data={projects}
      getRowId={(row) => row.id}
      hidePaginationWhenSinglePage
    />
  );
}
