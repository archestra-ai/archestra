"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  BookOpen,
  Braces,
  Info,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { SearchInput } from "@/components/search-input";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  useOrganization,
  useUpdateAgentSettings,
} from "@/lib/organization.query";
import {
  useDeleteSkill,
  useEnableSkillToolDefaults,
  useResetSkill,
  useSkillSourceRepos,
  useSkillsPaginated,
} from "@/lib/skills/skill.query";
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
  const appName = useAppName();

  const pageIndex = Number(searchParams.get("page") || "1") - 1;
  const pageSize = Number(searchParams.get("pageSize") || DEFAULT_TABLE_LIMIT);
  const search = searchParams.get("search") || "";
  const sourceRepo = searchParams.get("sourceRepo") || "";

  const {
    data: skills,
    isPending,
    isFetching,
  } = useSkillsPaginated({
    limit: pageSize,
    offset: pageIndex * pageSize,
    search: search || undefined,
    sourceRepo: sourceRepo || undefined,
  });
  const { data: sourceReposData } = useSkillSourceRepos();
  const sourceRepos = sourceReposData?.repos ?? [];

  const setSourceRepoFilter = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set("sourceRepo", value);
      } else {
        params.delete("sourceRepo");
      }
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [deletingSkill, setDeletingSkill] = useState<SkillItem | null>(null);
  const [resettingSkill, setResettingSkill] = useState<SkillItem | null>(null);
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const items = skills?.data ?? [];
  const pagination = skills?.pagination;
  const totalSkills = pagination?.total ?? 0;
  const hasActiveFilters = !!search || !!sourceRepo;
  const showEmptyState = !isPending && totalSkills === 0 && !hasActiveFilters;

  const clearFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("search");
    params.delete("sourceRepo");
    params.set("page", "1");
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  }, [pathname, router, searchParams]);

  const columns: ColumnDef<SkillItem>[] = [
    {
      id: "name",
      accessorKey: "name",
      header: "Skill",
      size: 700,
      cell: ({ row }) => {
        const skill = row.original;
        const repo = parseRepoFromSourceRef(skill.sourceRef);
        return (
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate font-medium">{skill.name}</span>
                {skill.sourceType === "built_in" && (
                  <Badge variant="secondary" className="shrink-0">
                    {appName}
                  </Badge>
                )}
                {repo && (
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {repo}
                  </span>
                )}
              </div>
              {skill.description && (
                <div className="truncate text-xs text-muted-foreground">
                  {skill.description}
                </div>
              )}
            </div>
            {skill.templated && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="gap-1">
                    <Braces className="h-3 w-3" />
                    templated
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  Body is rendered with Handlebars at activation.
                </TooltipContent>
              </Tooltip>
            )}
            {skill.compatibility && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="gap-1">
                    <Info className="h-3 w-3" />
                    compatibility
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
      id: "visibility",
      size: 160,
      header: "Visibility",
      cell: ({ row }) => (
        <ResourceVisibilityBadge
          scope={row.original.scope}
          teams={row.original.teams}
          authorId={row.original.authorId}
          authorName={row.original.authorName}
          currentUserId={currentUserId}
        />
      ),
    },
    {
      id: "files",
      size: 150,
      header: () => <div className="text-right">Files</div>,
      cell: ({ row }) => (
        <div className="text-right text-sm text-muted-foreground">
          {row.original.fileCount}{" "}
          {row.original.fileCount === 1 ? "file" : "files"}
        </div>
      ),
    },
    {
      id: "actions",
      size: 150,
      header: () => <div className="text-right">Actions</div>,
      cell: ({ row }) => {
        const skill = row.original;
        const isBuiltIn = skill.sourceType === "built_in";
        const actions: TableRowAction[] = [
          {
            icon: <Pencil className="h-4 w-4" />,
            label: "Edit",
            permissions: { skill: ["update"] },
            onClick: () => setEditingSkillId(skill.id),
          },
          ...(isBuiltIn
            ? [
                {
                  icon: <RotateCcw className="h-4 w-4" />,
                  label: "Reset to default",
                  permissions: { skill: ["update"] },
                  onClick: () => setResettingSkill(skill),
                } satisfies TableRowAction,
              ]
            : []),
          {
            icon: <Trash2 className="h-4 w-4" />,
            label: "Delete",
            variant: "destructive",
            permissions: { skill: ["delete"] },
            onClick: () => setDeletingSkill(skill),
          },
        ];
        return (
          <div className="flex justify-end">
            <TableRowActions actions={actions} />
          </div>
        );
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
        description=""
        actionButton={
          !showEmptyState && (
            <PermissionButton permissions={{ skill: ["create"] }} asChild>
              <Link href="/agents/skills/new">
                <Plus className="h-4 w-4" />
                Add new skill
              </Link>
            </PermissionButton>
          )
        }
      >
        {showEmptyState ? (
          <SkillsEmptyState />
        ) : (
          <>
            <div className="mb-6 flex flex-wrap items-center gap-3">
              <SearchInput paramName="search" className="relative w-[370px]" />
              <Select
                value={sourceRepo || "all"}
                onValueChange={(value) =>
                  setSourceRepoFilter(value === "all" ? "" : value)
                }
              >
                <SelectTrigger className="w-[260px]">
                  <SelectValue placeholder="All repositories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All repositories</SelectItem>
                  {sourceRepos.map((repo) => (
                    <SelectItem key={repo} value={repo}>
                      <span className="truncate font-mono text-xs">{repo}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <SkillSlashCommandToggle />
            </div>

            <DataTable
              columns={columns}
              data={items}
              getRowId={(row) => row.id}
              emptyMessage="No skills yet."
              hasActiveFilters={hasActiveFilters}
              filteredEmptyMessage="No skills match the current filters."
              onClearFilters={clearFilters}
              hideSelectedCount
              manualPagination
              pagination={{
                pageIndex,
                pageSize,
                total: totalSkills,
              }}
              onPaginationChange={(newPagination) => {
                const params = new URLSearchParams(searchParams.toString());
                params.set("page", String(newPagination.pageIndex + 1));
                params.set("pageSize", String(newPagination.pageSize));
                router.push(`${pathname}?${params.toString()}`, {
                  scroll: false,
                });
              }}
              onRowClick={(row) => setEditingSkillId(row.id)}
              isLoading={isFetching}
            />
          </>
        )}
      </PageLayout>

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

      {resettingSkill && (
        <ResetSkillDialog
          skill={resettingSkill}
          open={!!resettingSkill}
          onOpenChange={(open) => !open && setResettingSkill(null)}
        />
      )}
    </LoadingWrapper>
  );
}

/**
 * Org-level toggle exposing skills as `/skill-name` slash commands in chat.
 * Independent of `skillToolsEnabled` (the model-facing `load_skill` tool).
 */
function SkillSlashCommandToggle() {
  const { data: organization } = useOrganization();
  const { data: canUpdate } = useHasPermissions({ agent: ["update"] });
  const updateAgentSettings = useUpdateAgentSettings(
    "Skill slash commands updated",
    "Failed to update skill slash commands",
  );
  const enabled = organization?.skillSlashCommandsEnabled ?? false;
  // Slash commands depend on skill tools — the toggle stays locked until skills
  // are enabled for the organization (the empty-state "Enable" button).
  const skillToolsEnabled = organization?.skillToolsEnabled ?? false;
  const disabled =
    !canUpdate || updateAgentSettings.isPending || !skillToolsEnabled;

  return (
    <div className="ml-auto flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Switch
              id="skill-slash-commands"
              checked={enabled}
              disabled={disabled}
              onCheckedChange={(checked) =>
                updateAgentSettings.mutate({
                  skillSlashCommandsEnabled: checked,
                })
              }
            />
          </span>
        </TooltipTrigger>
        {!skillToolsEnabled && (
          <TooltipContent>
            Enable skills for this organization first.
          </TooltipContent>
        )}
      </Tooltip>
      <Label
        htmlFor="skill-slash-commands"
        className="text-sm text-muted-foreground"
      >
        Use skills as slash commands in chat
      </Label>
    </div>
  );
}

/** Extract `owner/repo` from a `source_ref` shaped like `owner/repo@ref:path`. */
function parseRepoFromSourceRef(sourceRef: string | null): string | null {
  if (!sourceRef) return null;
  // Built-in skills carry an internal `builtin:<id>` ref (e.g.
  // `builtin:archestra-platform-operations`); it is an identity token, not a
  // source repo, and would leak the unbranded "archestra" id into the UI. The
  // app-name badge already marks these as built-in, so show nothing here.
  if (sourceRef.startsWith("builtin:")) return null;
  const atIdx = sourceRef.indexOf("@");
  return atIdx === -1 ? sourceRef : sourceRef.slice(0, atIdx);
}

function SkillsEmptyState() {
  const router = useRouter();
  const { data: organization } = useOrganization();
  const enableDefaults = useEnableSkillToolDefaults();
  const alreadyEnabled = organization?.skillToolsEnabled === true;

  const handleEnableAndCreate = useCallback(async () => {
    const result = await enableDefaults.mutateAsync();
    if (result) {
      router.push("/agents/skills/new");
    }
  }, [enableDefaults, router]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl border bg-background shadow-sm">
          <BookOpen className="h-7 w-7 text-primary" />
        </div>
        <h2 className="mb-2 text-xl font-semibold">No skills yet</h2>
        <p className="mb-2 text-sm text-muted-foreground">
          A skill is a set of instructions and files. Agents pick the right one
          by name and follow it on demand.
        </p>
        {!alreadyEnabled && (
          <p className="mb-6 text-sm text-muted-foreground">
            Turning skills on makes them available to every agent in this
            organization.
          </p>
        )}
        <div className="flex items-center justify-center">
          {alreadyEnabled ? (
            <PermissionButton permissions={{ skill: ["create"] }} asChild>
              <Link href="/agents/skills/new">
                <Plus className="mr-2 h-4 w-4" />
                Add your first skill
              </Link>
            </PermissionButton>
          ) : (
            <PermissionButton
              permissions={{ skill: ["admin"] }}
              onClick={handleEnableAndCreate}
              disabled={enableDefaults.isPending}
            >
              <Plus className="mr-2 h-4 w-4" />
              {enableDefaults.isPending
                ? "Enabling…"
                : "Enable and create a new skill"}
            </PermissionButton>
          )}
        </div>
      </div>
    </div>
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

function ResetSkillDialog({
  skill,
  open,
  onOpenChange,
}: {
  skill: SkillItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const resetSkill = useResetSkill();
  const appName = useAppName();

  const handleReset = useCallback(async () => {
    const result = await resetSkill.mutateAsync(skill.id);
    if (result) {
      onOpenChange(false);
    }
  }, [skill.id, resetSkill, onOpenChange]);

  return (
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Reset Skill"
      description={`Reset "${skill.name}" to the version ${appName} ships? Any local edits to its instructions and resource files will be overwritten.`}
      isPending={resetSkill.isPending}
      onConfirm={handleReset}
      confirmLabel="Reset to default"
      pendingLabel="Resetting..."
    />
  );
}
