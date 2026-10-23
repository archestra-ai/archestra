"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type {
  ColumnDef,
  OnChangeFn,
  RowSelectionState,
} from "@tanstack/react-table";
import { ArchiveRestore, FolderKanban, Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { AgentIcon } from "@/components/agent-icon";
import { AgentNameCell } from "@/components/agent-name-cell";
import { permanentDeleteRowAction } from "@/components/permanent-delete";
import { RowPinButton } from "@/components/row-pin-button";
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

type ProjectListItem =
  archestraApiTypes.GetProjectsResponses["200"]["data"][number];
type TablePagination = { pageIndex: number; pageSize: number; total: number };

// The projects table under the pinned tiles. Row actions: pin/unpin, edit
// details, delete.
export function ProjectsTable({
  projects,
  pagination,
  onPaginationChange,
  isLoading,
  onTogglePin,
  onEdit,
  onDelete,
  rowSelection,
  onRowSelectionChange,
  canSelect,
  rangeSelection,
}: {
  /** One server page. */
  projects: ProjectListItem[];
  pagination: TablePagination;
  onPaginationChange: (pagination: {
    pageIndex: number;
    pageSize: number;
  }) => void;
  isLoading: boolean;
  onTogglePin: (project: ProjectListItem) => void;
  onEdit: (project: ProjectListItem) => void;
  onDelete: (project: ProjectListItem) => void;
  rowSelection: RowSelectionState;
  onRowSelectionChange: OnChangeFn<RowSelectionState>;
  canSelect: (project: ProjectListItem) => boolean;
  rangeSelection: BulkRangeSelectionController;
}) {
  const router = useRouter();
  const { data: isProjectAdmin } = useHasPermissions(
    { project: ["update"] },
    "*",
  );

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
      size: 360,
      cell: ({ row }) => {
        const project = row.original;
        return (
          <AgentNameCell
            name={project.name}
            href={`/projects/${project.id}`}
            icon={
              <AgentIcon icon={project.icon} fallbackType="project" size={16} />
            }
            labels={project.labels}
            description={project.description}
            extraBadges={
              // Someone else's project, reached through project oversight.
              project.viewerRole === "admin" && project.visibility === null ? (
                <Badge variant="secondary" className="shrink-0">
                  {project.ownerName
                    ? `Owned by ${project.ownerName}`
                    : "Other user"}
                </Badge>
              ) : undefined
            }
          />
        );
      },
    },
    {
      id: "actions",
      size: 136,
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
          isProjectAdmin: !!isProjectAdmin,
        });
        const actions: TableRowAction[] = [
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
        return (
          <div className="flex items-center justify-end gap-1.5">
            {canPin && (
              <RowPinButton
                name={project.name}
                pinned={Boolean(project.pinnedAt)}
                onToggle={() => onTogglePin(project)}
              />
            )}
            <ProjectTableActions project={project} actions={actions} />
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
      rangeSelection={rangeSelection}
      hideSelectedCount
      manualPagination
      pagination={pagination}
      onPaginationChange={onPaginationChange}
      isLoading={isLoading}
      onRowClick={(row) => router.push(`/projects/${row.id}`)}
      emptyIcon={FolderKanban}
      emptyMessage="No projects yet"
      hidePaginationWhenSinglePage
      tableClassName="table-fixed"
      fixedWidthColumnIds={["actions"]}
      flexibleColumnIds={["name"]}
    />
  );
}

// The trash view: soft-deleted projects org-wide (the backend serves this slice
// to project admins only). Rows deliberately do not navigate — the project page
// would 404 on a deleted id — and the actions collapse to Restore + Delete
// permanently, matching the agents and skills trash views.
export function DeletedProjectsTable({
  projects,
  pagination,
  onPaginationChange,
  isLoading,
  onRestore,
  onPermanentlyDelete,
}: {
  /** One server page of the trash. */
  projects: ProjectListItem[];
  pagination: TablePagination;
  onPaginationChange: (pagination: {
    pageIndex: number;
    pageSize: number;
  }) => void;
  isLoading: boolean;
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
                // Restore is decided by the project's own `delete` grant, like
                // deleting it, which an overseer of every project holds too.
                permissions: { project: ["delete"] },
                permissionScope: row.original.id,
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
      manualPagination
      pagination={pagination}
      onPaginationChange={onPaginationChange}
      isLoading={isLoading}
      hidePaginationWhenSinglePage
    />
  );
}

/**
 * A pinned project's "More actions" menu: what its row offers besides the
 * pin, which the tile shows on its own.
 */
export function ProjectActionsMenu({
  project,
  onEdit,
  onDelete,
}: {
  project: ProjectListItem;
  onEdit: (project: ProjectListItem) => void;
  onDelete: (project: ProjectListItem) => void;
}) {
  const { data: isProjectAdmin } = useHasPermissions(
    { project: ["update"] },
    "*",
  );
  const canManage = canManageProject(project.viewerRole, !!isProjectAdmin);
  const canDelete = canDeleteProject({
    viewerRole: project.viewerRole,
    isProjectAdmin: !!isProjectAdmin,
  });
  const dropdownActions: TableRowAction[] = [
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
  if (dropdownActions.length === 0) return null;
  return (
    <TableRowActions
      itemName={project.name}
      actions={[]}
      dropdownActions={dropdownActions}
    />
  );
}

function ProjectTableActions({
  project,
  actions,
}: {
  project: ProjectListItem;
  actions: TableRowAction[];
}) {
  return (
    <TableRowActions
      itemName={project.name}
      actions={actions.filter((action) => action.variant !== "destructive")}
      dropdownActions={actions.filter(
        (action) => action.variant === "destructive",
      )}
    />
  );
}
