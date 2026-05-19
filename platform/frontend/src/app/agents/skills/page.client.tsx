"use client";

import type { archestraApiTypes } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertTriangle, Github, Pencil, Plus, Trash2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { SearchInput } from "@/components/search-input";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { useDeleteSkill, useSkillsPaginated } from "@/lib/skills/skill.query";
import { ImportSkillsDialog } from "./_parts/import-skills-dialog";
import { SkillEditorDialog } from "./_parts/skill-editor-dialog";

type SkillItem = archestraApiTypes.GetSkillsResponses["200"]["data"][number];

export default function SkillsPage() {
  return (
    <div className="h-full w-full">
      <ErrorBoundary>
        <SkillsList />
      </ErrorBoundary>
    </div>
  );
}

function SkillsList() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const pageIndex = Number(searchParams.get("page") || "1") - 1;
  const pageSize = Number(searchParams.get("pageSize") || DEFAULT_TABLE_LIMIT);
  const search = searchParams.get("search") || "";

  const {
    data: skills,
    isPending,
    isFetching,
  } = useSkillsPaginated({
    limit: pageSize,
    offset: pageIndex * pageSize,
    search: search || undefined,
  });

  const [isImportOpen, setIsImportOpen] = useState(false);
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [deletingSkill, setDeletingSkill] = useState<SkillItem | null>(null);

  const items = skills?.data ?? [];
  const pagination = skills?.pagination;

  const clearFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("search");
    params.set("page", "1");
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  }, [pathname, router, searchParams]);

  const columns: ColumnDef<SkillItem>[] = [
    {
      id: "name",
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => {
        const skill = row.original;
        return (
          <div className="flex items-center gap-2">
            <div className="min-w-0">
              <div className="font-medium">{skill.name}</div>
              <div className="max-w-md truncate text-xs text-muted-foreground">
                {skill.description}
              </div>
            </div>
            {skill.compatibility && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className="gap-1 text-amber-600 dark:text-amber-500"
                  >
                    <AlertTriangle className="h-3 w-3" />
                    runtime
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>{skill.compatibility}</TooltipContent>
              </Tooltip>
            )}
          </div>
        );
      },
    },
    {
      id: "source",
      header: "Source",
      cell: ({ row }) => {
        const skill = row.original;
        const badge = (
          <Badge variant="secondary" className="capitalize">
            {skill.sourceType}
          </Badge>
        );
        return skill.sourceRef ? (
          <Tooltip>
            <TooltipTrigger asChild>{badge}</TooltipTrigger>
            <TooltipContent>{skill.sourceRef}</TooltipContent>
          </Tooltip>
        ) : (
          badge
        );
      },
    },
    {
      id: "files",
      header: "Files",
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.original.fileCount}{" "}
          {row.original.fileCount === 1 ? "file" : "files"}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => {
        const skill = row.original;
        const actions: TableRowAction[] = [
          {
            icon: <Pencil className="h-4 w-4" />,
            label: "Edit",
            onClick: () => setEditingSkillId(skill.id),
          },
          {
            icon: <Trash2 className="h-4 w-4" />,
            label: "Delete",
            variant: "destructive",
            onClick: () => setDeletingSkill(skill),
          },
        ];
        return <TableRowActions actions={actions} />;
      },
    },
  ];

  return (
    <LoadingWrapper
      isPending={isPending && !skills}
      loadingFallback={<LoadingSpinner />}
    >
      <PageLayout
        title="Skills"
        description="Reusable SKILL.md instruction sets that agents load on demand. Available to all agents in the organization."
        actionButton={
          <div className="flex items-center gap-2">
            <PermissionButton
              permissions={{ agent: ["create"] }}
              variant="outline"
              onClick={() => setIsImportOpen(true)}
            >
              <Github className="h-4 w-4" />
              Import from GitHub
            </PermissionButton>
            <PermissionButton
              permissions={{ agent: ["create"] }}
              onClick={() => setIsCreateOpen(true)}
            >
              <Plus className="h-4 w-4" />
              New Skill
            </PermissionButton>
          </div>
        }
      >
        <div className="mb-6 flex items-center gap-4">
          <SearchInput paramName="search" className="relative w-[370px]" />
        </div>

        <DataTable
          columns={columns}
          data={items}
          getRowId={(row) => row.id}
          emptyMessage="No skills yet. Import from GitHub or create one manually."
          hasActiveFilters={!!search}
          filteredEmptyMessage="No skills match your search."
          onClearFilters={clearFilters}
          hideSelectedCount
          manualPagination
          pagination={{
            pageIndex,
            pageSize,
            total: pagination?.total ?? 0,
          }}
          onPaginationChange={(newPagination) => {
            const params = new URLSearchParams(searchParams.toString());
            params.set("page", String(newPagination.pageIndex + 1));
            params.set("pageSize", String(newPagination.pageSize));
            router.push(`${pathname}?${params.toString()}`, { scroll: false });
          }}
          onRowClick={(row) => setEditingSkillId(row.id)}
          isLoading={isFetching}
        />
      </PageLayout>

      <ImportSkillsDialog open={isImportOpen} onOpenChange={setIsImportOpen} />

      <SkillEditorDialog
        skillId={null}
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
      />

      {editingSkillId && (
        <SkillEditorDialog
          skillId={editingSkillId}
          open={!!editingSkillId}
          onOpenChange={(open) => !open && setEditingSkillId(null)}
        />
      )}

      {deletingSkill && (
        <DeleteSkillDialog
          skill={deletingSkill}
          open={!!deletingSkill}
          onOpenChange={(open) => !open && setDeletingSkill(null)}
        />
      )}
    </LoadingWrapper>
  );
}

function DeleteSkillDialog({
  skill,
  open,
  onOpenChange,
}: {
  skill: SkillItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteSkill = useDeleteSkill();

  const handleDelete = useCallback(async () => {
    const result = await deleteSkill.mutateAsync(skill.id);
    if (result) {
      onOpenChange(false);
    }
  }, [skill.id, deleteSkill, onOpenChange]);

  return (
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete Skill"
      description={`Delete the skill "${skill.name}"? This removes its instructions and resource files. This action cannot be undone.`}
      isPending={deleteSkill.isPending}
      onConfirm={handleDelete}
      confirmLabel="Delete Skill"
      pendingLabel="Deleting..."
    />
  );
}
