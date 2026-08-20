"use client";

import { type archestraApiTypes, E2eTestId } from "@archestra/shared";
import type {
  ColumnDef,
  RowSelectionState,
  SortingState,
} from "@tanstack/react-table";
import {
  ArchiveRestore,
  BookOpen,
  Braces,
  ChartColumn,
  ChevronDown,
  ChevronUp,
  History,
  Info,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import {
  PERMANENT_DELETE_LABEL,
  permanentDeleteRowAction,
} from "@/components/permanent-delete";
import { QueryLoadError } from "@/components/query-load-error";
import {
  ActiveFilterBadges,
  ResourceDeletedStatusFilter,
  ResourceScopeFilter,
  useScopeFilterParams,
} from "@/components/resource-scope-filter";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { SearchInput } from "@/components/search-input";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { BulkActionsBar } from "@/components/ui/bulk-actions-bar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { useSession } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useIsGlobalAdmin } from "@/lib/organization.query";
import {
  useBulkDeleteSkills,
  usePermanentlyDeleteSkill,
  useRestoreSkill,
  useSkillSourceRepos,
  useSkillsPaginated,
} from "@/lib/skills/skill.query";
import { parseRepoFromSourceRef } from "@/lib/skills/skill-source";
import { cn } from "@/lib/utils";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { BulkVisibilityDialog } from "./_parts/bulk-visibility-dialog";
import { DeleteSkillDialog } from "./_parts/delete-skill-dialog";
import { skillEditHref } from "./_parts/skill-page-config";
import { SkillUsageDialog } from "./_parts/skill-usage-dialog";
import { SkillVersionHistoryDialog } from "./_parts/skill-version-history-dialog";

type SkillItem = archestraApiTypes.GetSkillsResponses["200"]["data"][number];

const SYNC_INTERVAL_LABELS: Record<string, string> = {
  "15m": "Synced every 15 minutes",
  "1h": "Synced every hour",
  "1d": "Synced once a day",
};

const SKILLS_DESCRIPTION =
  "Skills teach your agents reusable expertise — a SKILL.md instruction set plus optional resource files, loaded on demand and invocable in chat as slash commands.";

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
  const scopeFilter = useScopeFilterParams();
  // The trash view; the backend restricts `status=deleted` to admins/team-admins
  // and the status filter itself is only shown to skill admins.
  const isDeletedView = searchParams.get("status") === "deleted";

  type SkillSortBy = NonNullable<
    NonNullable<archestraApiTypes.GetSkillsData["query"]>["sortBy"]
  >;
  const sortBy =
    (searchParams.get("sortBy") as SkillSortBy | null) || "usageCount";
  const sortDirection =
    (searchParams.get("sortDirection") as "asc" | "desc" | null) || "desc";

  const {
    data: skills,
    isPending,
    isFetching,
    isLoadingError: isSkillsLoadError,
    refetch: refetchSkills,
  } = useSkillsPaginated(
    {
      limit: pageSize,
      offset: pageIndex * pageSize,
      search: search || undefined,
      sourceRepo: sourceRepo || undefined,
      scope: scopeFilter.scope,
      teamIds: scopeFilter.teamIds,
      authorIds: scopeFilter.authorIds,
      excludeAuthorIds: scopeFilter.excludeAuthorIds,
      excludeOtherPersonalSkills: scopeFilter.excludeOtherPersonal,
      status: isDeletedView ? "deleted" : undefined,
      sortBy,
      sortDirection,
    },
    { toastOnError: false },
  );
  const { data: sourceReposData } = useSkillSourceRepos();
  const sourceRepos = sourceReposData?.repos ?? [];
  const restoreSkill = useRestoreSkill();
  const admin = useIsGlobalAdmin();

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

  const [sorting, setSorting] = useState<SortingState>([
    { id: sortBy, desc: sortDirection === "desc" },
  ]);

  // Keep the table's sort indicators in sync with the URL-driven state.
  useEffect(() => {
    setSorting([{ id: sortBy, desc: sortDirection === "desc" }]);
  }, [sortBy, sortDirection]);

  const handleSortingChange = useCallback(
    (updater: SortingState | ((old: SortingState) => SortingState)) => {
      const newSorting =
        typeof updater === "function" ? updater(sorting) : updater;
      setSorting(newSorting);

      const params = new URLSearchParams(searchParams.toString());
      params.set("page", "1");
      if (newSorting.length > 0) {
        params.set("sortBy", newSorting[0].id);
        params.set("sortDirection", newSorting[0].desc ? "desc" : "asc");
      } else {
        params.delete("sortBy");
        params.delete("sortDirection");
      }
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [sorting, pathname, router, searchParams],
  );

  // Legacy deep link: the editor used to be a dialog on this page opened by
  // `?edit=<skillId>`; it is the skill's edit wizard now.
  const editId = searchParams.get("edit");
  useEffect(() => {
    if (editId) router.replace(skillEditHref(editId));
  }, [editId, router]);

  const [deletingSkill, setDeletingSkill] = useState<SkillItem | null>(null);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [bulkVisibilityOpen, setBulkVisibilityOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [permanentlyDeletingSkill, setPermanentlyDeletingSkill] =
    useState<SkillItem | null>(null);
  const [historySkillId, setHistorySkillId] = useState<string | null>(null);
  const [usageSkill, setUsageSkill] = useState<SkillItem | null>(null);
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const items = skills?.data ?? [];
  const bulkDeleteSkills = useBulkDeleteSkills();

  // Derived from what is on screen rather than read straight out of
  // `rowSelection`: the table is server-paginated, so a bulk action must only
  // ever touch rows the user can actually see. Ids left over from another page
  // simply drop out here — including in the trash view, which renders no
  // checkbox column and so must never surface a bar for a skill that was
  // ticked while active and deleted from under the selection.
  const selectedSkills = isDeletedView
    ? []
    : items.filter((skill) => rowSelection[skill.id]);
  const clearSelection = useCallback(() => setRowSelection({}), []);

  // Deep-link support: /skills?openEdit=<name> opens the matching skill's page
  // (e.g. from the chat SkillPill). The name resolves to an id once the items
  // it was searched by have loaded.
  const openEdit = searchParams.get("openEdit");
  useEffect(() => {
    if (!openEdit || items.length === 0) return;
    const match = items.find((s) => s.name === openEdit);
    if (!match) return;
    router.replace(`/skills/${match.id}`);
  }, [openEdit, items, router]);
  const pagination = skills?.pagination;
  const totalSkills = pagination?.total ?? 0;
  const hasActiveFilters =
    !!search ||
    !!sourceRepo ||
    scopeFilter.hasActiveScopeFilters ||
    isDeletedView;
  const showEmptyState = !isPending && totalSkills === 0 && !hasActiveFilters;

  const clearFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of [
      "search",
      "sourceRepo",
      "scope",
      "teamIds",
      "authorIds",
      "excludeAuthorIds",
      "status",
    ]) {
      params.delete(key);
    }
    params.set("page", "1");
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  }, [pathname, router, searchParams]);

  const columns: ColumnDef<SkillItem>[] = [
    // A deleted row can only be restored or purged, neither of which this
    // selection drives, so the trash view keeps its rows unselectable rather
    // than offering a checkbox with nothing to apply.
    ...(isDeletedView ? [] : [selectColumn]),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Skill
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      size: 420,
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
                {skill.githubSyncInterval && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="outline"
                        className={cn(
                          "shrink-0 gap-1",
                          skill.lastSyncError && "text-destructive",
                        )}
                      >
                        <RefreshCw className="h-3 w-3" />
                        synced
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      {SYNC_INTERVAL_LABELS[skill.githubSyncInterval]} from
                      GitHub; read-only until disconnected.
                      {skill.lastSyncError
                        ? ` Last sync failed: ${skill.lastSyncError}`
                        : ` Last synced: ${formatRelativeTimeFromNow(
                            skill.lastSyncedAt,
                            { neverLabel: "not yet" },
                          )}.`}
                    </TooltipContent>
                  </Tooltip>
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
      size: 130,
      header: "Visibility",
      cell: ({ row }) => (
        <ResourceVisibilityBadge
          scope={row.original.scope}
          teams={row.original.teams}
          users={row.original.users}
          authorId={row.original.authorId}
          authorName={row.original.authorName}
          currentUserId={currentUserId}
          showSelfAsMe
        />
      ),
    },
    {
      id: "files",
      size: 90,
      header: () => <div className="text-right">Files</div>,
      cell: ({ row }) => (
        <div className="text-right text-sm text-muted-foreground">
          {row.original.fileCount}{" "}
          {row.original.fileCount === 1 ? "file" : "files"}
        </div>
      ),
    },
    {
      id: "usageCount",
      accessorKey: "usageCount",
      size: 120,
      header: ({ column }) => (
        // Right padding keeps the right-aligned value from sitting flush
        // against the Actions buttons in the next cell.
        <div className="flex justify-end pr-4">
          <Button
            variant="ghost"
            className="h-auto !p-0 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Uses
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        </div>
      ),
      cell: ({ row }) => (
        <div className="flex justify-end pr-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="w-full rounded px-1.5 py-0.5 text-right text-sm hover:bg-muted"
                onClick={(e) => {
                  e.stopPropagation();
                  setUsageSkill(row.original);
                }}
              >
                <div>
                  {row.original.usageCount}
                  {row.original.usageUserCount > 0 && (
                    <span className="text-muted-foreground">
                      {" "}
                      by {row.original.usageUserCount}{" "}
                      {row.original.usageUserCount === 1 ? "user" : "users"}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatRelativeTimeFromNow(row.original.lastUsedAt, {
                    neverLabel: "Never used",
                  })}
                </div>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              Who used this skill over the last month
            </TooltipContent>
          </Tooltip>
        </div>
      ),
    },
    {
      id: "actions",
      size: 150,
      header: () => <div className="text-right">Actions</div>,
      cell: ({ row }) => {
        const skill = row.original;
        // A soft-deleted skill can only be restored; edit/chat/usage/delete all
        // act on active rows and would 404.
        const actions: TableRowAction[] = isDeletedView
          ? [
              {
                icon: <ArchiveRestore className="h-4 w-4" />,
                label: "Restore",
                permissions: { skill: ["delete"] },
                onClick: () => restoreSkill.mutate(skill.id),
              },
              permanentDeleteRowAction({
                admin,
                onClick: () => setPermanentlyDeletingSkill(skill),
                // A built-in's deleted row IS the opt-out: it is what stops the
                // startup seeder recreating the skill, so the API refuses to
                // destroy it and deleting it already removed it for good.
                disabledReason:
                  skill.sourceType === "built_in"
                    ? "A deleted built-in skill is already gone for good; its record is what stops it coming back on the next restart"
                    : undefined,
              }),
            ]
          : [
              {
                icon: <Pencil className="h-4 w-4" />,
                label: "Edit",
                permissions: { skill: ["update"] },
                href: skillEditHref(skill.id),
              },
              {
                icon: <MessageSquare className="h-4 w-4" />,
                label: "Chat",
                permissions: { chat: ["read", "create"] },
                href: `/chat/new?skill_id=${skill.id}`,
              },
              {
                icon: <ChartColumn className="h-4 w-4" />,
                label: "Usage",
                permissions: { skill: ["read"] },
                onClick: () => setUsageSkill(skill),
              },
              {
                icon: <History className="h-4 w-4" />,
                label: "Version history",
                permissions: { skill: ["read"] },
                onClick: () => setHistorySkillId(skill.id),
              },
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
            <TableRowActions actions={actions} itemName={skill.name} />
          </div>
        );
      },
    },
  ];

  if (isSkillsLoadError) {
    return (
      <PageLayout title="Skills" description={SKILLS_DESCRIPTION}>
        <QueryLoadError
          title="Couldn't load your skills"
          onRetry={() => refetchSkills()}
        />
      </PageLayout>
    );
  }

  return (
    <LoadingWrapper
      isPending={isPending && !skills}
      loadingFallback={<LoadingSpinner />}
    >
      <PageLayout
        title="Skills"
        description={SKILLS_DESCRIPTION}
        actionButton={
          !showEmptyState && (
            <PermissionButton permissions={{ skill: ["create"] }} asChild>
              <Link href="/skills/new">
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
            <div className="mb-6 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-3">
                <SearchInput
                  paramName="search"
                  className="relative w-[370px]"
                />
                <ResourceScopeFilter
                  ownerLabelPlural="skills"
                  adminPermission={{ skill: ["admin"] }}
                />
                {/* Backend gates status=deleted on isAdmin||isTeamAdmin; the
                    checker has no `skill:delete` boolean, so this shows the
                    trash toggle to skill admins to avoid a control that 403s. */}
                <ResourceDeletedStatusFilter
                  deletePermission={{ skill: ["admin"] }}
                />
                {/* Only imported skills have a repository, so the filter would
                    be a single inert "All repositories" entry until at least
                    one skill is imported. */}
                {sourceRepos.length > 0 && (
                  <Select
                    value={sourceRepo || "all"}
                    onValueChange={(value) =>
                      setSourceRepoFilter(value === "all" ? "" : value)
                    }
                  >
                    <SelectTrigger
                      aria-label="Filter by repository"
                      className="w-[260px]"
                    >
                      <SelectValue placeholder="All repositories" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All repositories</SelectItem>
                      {sourceRepos.map((repo) => (
                        <SelectItem key={repo} value={repo}>
                          <span className="truncate font-mono text-xs">
                            {repo}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <ActiveFilterBadges adminPermission={{ skill: ["admin"] }} />
            </div>

            <BulkActionsBar
              count={selectedSkills.length}
              noun="skill"
              countTestId={E2eTestId.SkillsBulkSelectionCount}
              onClear={clearSelection}
              className="mb-3"
            >
              <PermissionButton
                permissions={{ skill: ["update"] }}
                variant="outline"
                size="sm"
                onClick={() => setBulkVisibilityOpen(true)}
              >
                <Pencil className="h-4 w-4" />
                <span>Edit visibility</span>
              </PermissionButton>
              <PermissionButton
                permissions={{ skill: ["delete"] }}
                variant="destructive"
                size="sm"
                onClick={() => setBulkDeleteOpen(true)}
              >
                <Trash2 className="h-4 w-4" />
                <span>Delete</span>
              </PermissionButton>
            </BulkActionsBar>

            <DataTable
              columns={columns}
              data={items}
              getRowId={(row) => row.id}
              emptyMessage="No skills yet."
              hasActiveFilters={hasActiveFilters}
              filteredEmptyMessage={
                isDeletedView
                  ? "No deleted skills found."
                  : "No skills match the current filters."
              }
              onClearFilters={clearFilters}
              hideSelectedCount
              manualPagination
              manualSorting
              sorting={sorting}
              onSortingChange={handleSortingChange}
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
              onRowClick={
                isDeletedView
                  ? undefined
                  : (row) => router.push(`/skills/${row.id}`)
              }
              rowSelection={rowSelection}
              onRowSelectionChange={setRowSelection}
              isLoading={isFetching}
            />
          </>
        )}
      </PageLayout>

      {bulkVisibilityOpen && (
        <BulkVisibilityDialog
          skills={selectedSkills}
          open={bulkVisibilityOpen}
          onOpenChange={setBulkVisibilityOpen}
          onApplied={clearSelection}
        />
      )}

      {bulkDeleteOpen && (
        <DeleteConfirmDialog
          open={bulkDeleteOpen}
          onOpenChange={setBulkDeleteOpen}
          title="Delete skills"
          description={`Delete ${selectedSkills.length} ${
            selectedSkills.length === 1 ? "skill" : "skills"
          }? Each one is removed along with its instructions and resource files.`}
          isPending={bulkDeleteSkills.isPending}
          onConfirm={() => {
            bulkDeleteSkills.mutate(
              selectedSkills.map((skill) => skill.id),
              {
                onSuccess: (result) => {
                  if (!result || result.succeeded.length === 0) return;
                  clearSelection();
                  setBulkDeleteOpen(false);
                },
              },
            );
          }}
          confirmLabel="Delete skills"
          pendingLabel="Deleting..."
        />
      )}

      {deletingSkill && (
        <DeleteSkillDialog
          skill={deletingSkill}
          open={!!deletingSkill}
          onOpenChange={(open) => !open && setDeletingSkill(null)}
        />
      )}

      {permanentlyDeletingSkill && (
        <PermanentlyDeleteSkillDialog
          skill={permanentlyDeletingSkill}
          open={!!permanentlyDeletingSkill}
          onOpenChange={(open) => !open && setPermanentlyDeletingSkill(null)}
        />
      )}

      {historySkillId && (
        <SkillVersionHistoryDialog
          skillId={historySkillId}
          open={!!historySkillId}
          onOpenChange={(open) => !open && setHistorySkillId(null)}
        />
      )}

      {usageSkill && (
        <SkillUsageDialog
          skillId={usageSkill.id}
          skillName={usageSkill.name}
          open={!!usageSkill}
          onOpenChange={(open) => !open && setUsageSkill(null)}
        />
      )}
    </LoadingWrapper>
  );
}

/**
 * The multiselect checkbox column. Clicks are kept off the row so ticking a
 * skill does not also open its editor, which the row click opens.
 */
const selectColumn: ColumnDef<SkillItem> = {
  id: "select",
  size: 40,
  minSize: 44,
  header: ({ table }) => (
    <Checkbox
      checked={
        table.getIsAllPageRowsSelected() ||
        (table.getIsSomePageRowsSelected() && "indeterminate")
      }
      onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
      onClick={(event) => event.stopPropagation()}
      aria-label="Select all skills on this page"
    />
  ),
  cell: ({ row }) => (
    <Checkbox
      checked={row.getIsSelected()}
      onCheckedChange={(value) => row.toggleSelected(!!value)}
      onClick={(event) => event.stopPropagation()}
      aria-label={`Select ${row.original.name}`}
    />
  ),
};

function SortIcon({ isSorted }: { isSorted: "asc" | "desc" | false }) {
  const upArrow = <ChevronUp className="h-3 w-3" />;
  const downArrow = <ChevronDown className="h-3 w-3" />;
  if (isSorted === "asc") {
    return upArrow;
  }
  if (isSorted === "desc") {
    return downArrow;
  }
  return (
    <div className="text-muted-foreground flex flex-col items-center">
      {upArrow}
      <span className="mt-[-4px]">{downArrow}</span>
    </div>
  );
}

function SkillsEmptyState() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl border bg-background shadow-sm">
          <BookOpen className="h-7 w-7 text-primary" />
        </div>
        <h2 className="mb-2 text-xl font-semibold">No skills yet</h2>
        <p className="mb-6 text-sm text-muted-foreground">
          A skill is a set of instructions and files. Agents pick the right one
          by name and follow it on demand.
        </p>
        <div className="flex items-center justify-center">
          <PermissionButton permissions={{ skill: ["create"] }} asChild>
            <Link href="/skills/new">
              <Plus className="mr-2 h-4 w-4" />
              Add your first skill
            </Link>
          </PermissionButton>
        </div>
      </div>
    </div>
  );
}

function PermanentlyDeleteSkillDialog({
  skill,
  open,
  onOpenChange,
}: {
  skill: SkillItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const permanentlyDeleteSkill = usePermanentlyDeleteSkill();

  const handleDelete = useCallback(async () => {
    const result = await permanentlyDeleteSkill.mutateAsync(skill.id);
    if (result) {
      onOpenChange(false);
    }
  }, [skill.id, permanentlyDeleteSkill, onOpenChange]);

  return (
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete skill permanently"
      description={`This destroys "${skill.name}" along with every version and resource file, its grants and environment assignments, and any public share link for it. Nothing recovers it.`}
      isPending={permanentlyDeleteSkill.isPending}
      onConfirm={handleDelete}
      confirmLabel={PERMANENT_DELETE_LABEL}
    />
  );
}
