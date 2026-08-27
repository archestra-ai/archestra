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
  History,
  Info,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import {
  FilterBar,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import { PageLayout } from "@/components/page-layout";
import {
  PERMANENT_DELETE_LABEL,
  permanentDeleteRowAction,
} from "@/components/permanent-delete";
import { QueryLoadError } from "@/components/query-load-error";
import { RepositoryOwnerIcon } from "@/components/repository-owner-icon";
import {
  ActiveFilterBadges,
  ResourceDeletedStatusFilter,
  ResourceScopeFilter,
  useScopeFilterParams,
} from "@/components/resource-scope-filter";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { SearchInput } from "@/components/search-input";
import { useSkillsPluginsNavTabs } from "@/components/skills-plugins-nav-tabs";
import {
  TableCard,
  TableCardView,
  TableCardViewToggle,
} from "@/components/table-card-view";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
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
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { ACTION_LABEL, notYoursToChange } from "@/lib/design/resource-lexicon";
import { useAppIconLogo, useAppName } from "@/lib/hooks/use-app-name";
import { useBulkCardSelection } from "@/lib/hooks/use-bulk-card-selection";
import { useControlledRowSelection } from "@/lib/hooks/use-bulk-selection";
import { useIsGlobalAdmin } from "@/lib/organization.query";
import {
  useAllMatchingSkills,
  useBulkDeleteSkills,
  useExternalMcpSkills,
  usePermanentlyDeleteSkill,
  usePluginSkills,
  useRestoreSkill,
  useSkillSourceRepos,
  useSkillsPaginated,
} from "@/lib/skills/skill.query";
import { parseRepoFromSourceRef } from "@/lib/skills/skill-source";
import { computeCanModifySkill } from "@/lib/skills/use-skill-access";
import { useMyTeams } from "@/lib/teams/team.query";
import { cn } from "@/lib/utils";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { BulkVisibilityDialog } from "./_parts/bulk-visibility-dialog";
import { DeleteSkillDialog } from "./_parts/delete-skill-dialog";
import {
  ExternalMcpSkillsSection,
  filterExternalMcpSkills,
} from "./_parts/external-mcp-skills-section";
import {
  filterPluginSkills,
  PluginSkillsSection,
} from "./_parts/plugin-skills-section";
import {
  getSkillActionModel,
  skillAction,
  skillActionHref,
} from "./_parts/skill-actions-model";
import {
  SkillCollection,
  SkillSortableHeader,
} from "./_parts/skill-collection";
import { skillEditHref, skillUsageHref } from "./_parts/skill-page-config";
import { SkillUsageSummary } from "./_parts/skill-usage-summary";
import { SkillVersionHistoryDialog } from "./_parts/skill-version-history-dialog";

type SkillItem = archestraApiTypes.GetSkillsResponses["200"]["data"][number];
type SkillKind = "all" | "standalone" | "mcp" | "plugin";

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
  const tabs = useSkillsPluginsNavTabs();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const appName = useAppName();
  const appIconLogo = useAppIconLogo();

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

  /**
   * Everything that narrows the table, with the page itself left out — the
   * visible page and "every matching skill" differ only by limit/offset.
   */
  const listFilters = {
    search: search || undefined,
    sourceRepo: sourceRepo || undefined,
    scope: scopeFilter.scope,
    teamIds: scopeFilter.teamIds,
    authorIds: scopeFilter.authorIds,
    excludeAuthorIds: scopeFilter.excludeAuthorIds,
    excludeOtherPersonalSkills: scopeFilter.excludeOtherPersonal,
    status: isDeletedView ? ("deleted" as const) : undefined,
    sortBy,
    sortDirection,
  };

  const {
    data: skills,
    isFetching,
    isLoadingError: isSkillsLoadError,
    refetch: refetchSkills,
  } = useSkillsPaginated(
    {
      limit: pageSize,
      offset: pageIndex * pageSize,
      ...listFilters,
    },
    { toastOnError: false },
  );
  const { data: sourceReposData } = useSkillSourceRepos();
  const sourceRepos = sourceReposData?.repos ?? [];
  const mcpSkillsEnabled = useFeature("mcpGatewaySkillsEnabled") === true;
  const pluginsEnabled = useFeature("plugins") === true;
  const { data: canReadPlugins } = useHasPermissions({ plugin: ["read"] });
  const pluginSkillsEnabled = pluginsEnabled && canReadPlugins === true;
  const kindParam = searchParams.get("kind");
  const requestedKind: SkillKind =
    kindParam === "standalone" || kindParam === "mcp" || kindParam === "plugin"
      ? kindParam
      : "all";
  const kind: SkillKind =
    isDeletedView || (!mcpSkillsEnabled && !pluginSkillsEnabled)
      ? "standalone"
      : requestedKind === "mcp" && !mcpSkillsEnabled
        ? "all"
        : requestedKind === "plugin" && !pluginSkillsEnabled
          ? "all"
          : requestedKind;
  const showStandaloneSkills = kind === "all" || kind === "standalone";
  const showMcpSkills =
    mcpSkillsEnabled && !isDeletedView && (kind === "all" || kind === "mcp");
  const showPluginSkills =
    pluginSkillsEnabled &&
    !isDeletedView &&
    (kind === "all" || kind === "plugin");
  const { data: externalSkills = [], isFetching: isExternalSkillsFetching } =
    useExternalMcpSkills({
      enabled: showMcpSkills,
    });
  const visibleExternalSkills = sourceRepo
    ? []
    : filterExternalMcpSkills({
        skills: externalSkills,
        search,
        scope: scopeFilter.scope,
      });
  const { data: pluginSkills = [], isFetching: isPluginSkillsFetching } =
    usePluginSkills({ enabled: showPluginSkills });
  const visiblePluginSkills = sourceRepo
    ? []
    : filterPluginSkills({
        skills: pluginSkills,
        search,
        scope: scopeFilter.scope,
      });
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

  const setKindFilter = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === "all") {
        params.delete("kind");
      } else {
        params.set("kind", value);
      }
      if (value === "mcp" || value === "plugin") {
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
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  // Resolved once for the whole table, then applied per row: the scope check
  // is a pure function precisely so a table cell does not have to call hooks.
  const { data: isSkillAdmin } = useHasPermissions({ skill: ["admin"] });
  const { data: isSkillTeamAdmin } = useHasPermissions({
    skill: ["team-admin"],
  });
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: userTeams } = useMyTeams({ enabled: !!canReadTeams });
  const userTeamIdSet = new Set((userTeams ?? []).map((team) => team.id));

  const items = skills?.data ?? [];
  const bulkDeleteSkills = useBulkDeleteSkills();
  // Derived from what is on screen rather than read straight out of
  // `rowSelection`: the table is server-paginated, so a bulk action must only
  /**
   * An escalation is remembered as the filters it was made under, so changing
   * a filter drops it rather than silently re-pointing "all 203 skills" at a
   * different 203. It also keeps the offer honest: it is only ever shown when
   * the whole matching set fits in one bulk request, so an escalation that
   * survived a filter change could otherwise claim more than it can act on.
   */
  const filterSignature = JSON.stringify(listFilters);
  const [escalatedFor, setEscalatedFor] = useState<string | null>(null);
  const allMatchingSelected = escalatedFor === filterSignature;
  const { effectiveRowSelection, onRowSelectionChange } =
    useControlledRowSelection({
      rowSelection,
      setRowSelection,
      rows: items,
      getRowId: (row) => row.id,
      allMatchingSelected,
      clearEscalation: () => setEscalatedFor(null),
    });
  const cardSelection = useBulkCardSelection({
    rows: items,
    getRowId: (row) => row.id,
    rowSelection: effectiveRowSelection,
    setRowSelection: onRowSelectionChange,
  });

  const { data: allMatchingSkills, isFetching: isFetchingAllMatching } =
    useAllMatchingSkills(listFilters, { enabled: allMatchingSelected });

  // Only visible rows enter a manual selection. Escalation materializes the
  // visible page so table and card controls stay checked until changed.
  const pageSelection = isDeletedView
    ? []
    : items.filter((skill) => effectiveRowSelection[skill.id]);

  const selectedSkills = allMatchingSelected
    ? (allMatchingSkills ?? pageSelection)
    : pageSelection;

  const clearSelection = useCallback(() => {
    setRowSelection({});
    setEscalatedFor(null);
  }, []);

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
    isDeletedView ||
    ((mcpSkillsEnabled || pluginSkillsEnabled) &&
      !isDeletedView &&
      kind !== "all");
  const hasVisibleSkills =
    (showStandaloneSkills && totalSkills > 0) ||
    (showMcpSkills && visibleExternalSkills.length > 0) ||
    (showPluginSkills && visiblePluginSkills.length > 0);
  const showEmptyState =
    !isFetching &&
    !(showMcpSkills && isExternalSkillsFetching) &&
    !(showPluginSkills && isPluginSkillsFetching) &&
    !hasVisibleSkills &&
    !hasActiveFilters;
  const noVisibleFilterResults =
    totalSkills === 0 &&
    visibleExternalSkills.length === 0 &&
    visiblePluginSkills.length === 0;
  const showStandaloneSection =
    showStandaloneSkills &&
    (totalSkills > 0 ||
      kind === "standalone" ||
      isDeletedView ||
      (kind === "all" && noVisibleFilterResults));
  const showMcpSection =
    showMcpSkills && (visibleExternalSkills.length > 0 || kind === "mcp");
  const showPluginSection =
    showPluginSkills && (visiblePluginSkills.length > 0 || kind === "plugin");
  const showStandaloneHeading =
    isDeletedView || mcpSkillsEnabled || pluginSkillsEnabled;

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
      "kind",
    ]) {
      params.delete(key);
    }
    params.set("page", "1");
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  }, [pathname, router, searchParams]);

  const handlePaginationChange = (newPagination: {
    pageIndex: number;
    pageSize: number;
  }) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(newPagination.pageIndex + 1));
    params.set("pageSize", String(newPagination.pageSize));
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const renderSkillActions = (skill: SkillItem) => {
    const actionModel = getSkillActionModel(skill.id);
    const chatAction = skillAction(actionModel, "chat");
    const editAction = skillAction(actionModel, "edit");
    const usageAction = skillAction(actionModel, "usage");
    const historyAction = skillAction(actionModel, "history");
    const deleteAction = skillAction(actionModel, "delete");
    const canModify = computeCanModifySkill({
      skill,
      isAdmin: !!isSkillAdmin,
      isTeamAdmin: !!isSkillTeamAdmin,
      currentUserId,
      userTeamIds: userTeamIdSet,
    });
    const notYours = notYoursToChange({
      resource: "skill",
      scope: skill.scope,
    });
    const actions: TableRowAction[] = isDeletedView
      ? [
          {
            icon: <ArchiveRestore className="h-4 w-4" />,
            label: ACTION_LABEL.restore,
            permissions: { skill: ["delete"] },
            disabled: !canModify,
            disabledTooltip: notYours,
            onClick: () => restoreSkill.mutate(skill.id),
          },
        ]
      : [
          {
            icon: <MessageSquare className="h-4 w-4" />,
            label: chatAction.label,
            permissions: chatAction.permissions,
            href: skillActionHref(chatAction),
          },
          {
            icon: <Pencil className="h-4 w-4" />,
            label: editAction.label,
            permissions: editAction.permissions,
            disabled: !canModify,
            disabledTooltip: notYours,
            href: skillActionHref(editAction),
          },
        ];
    const dropdownActions: TableRowAction[] = isDeletedView
      ? [
          permanentDeleteRowAction({
            admin,
            onClick: () => setPermanentlyDeletingSkill(skill),
            disabledReason:
              skill.sourceType === "built_in"
                ? "A deleted built-in skill is already gone for good; its record is what stops it coming back on the next restart"
                : undefined,
          }),
        ]
      : [
          {
            icon: <ChartColumn className="h-4 w-4" />,
            label: usageAction.label,
            permissions: usageAction.permissions,
            onClick: () => router.push(skillUsageHref(skill.id)),
          },
          {
            icon: <History className="h-4 w-4" />,
            label: historyAction.label,
            permissions: historyAction.permissions,
            onClick: () => setHistorySkillId(skill.id),
          },
          {
            icon: <Trash2 className="h-4 w-4" />,
            label: deleteAction.label,
            variant: "destructive",
            permissions: deleteAction.permissions,
            disabled: !canModify,
            disabledTooltip: notYours,
            onClick: () => setDeletingSkill(skill),
          },
        ];
    return (
      <TableRowActions
        actions={actions}
        dropdownActions={dropdownActions}
        itemName={skill.name}
      />
    );
  };

  const columns: ColumnDef<SkillItem>[] = [
    // A deleted row can only be restored or purged, neither of which this
    // selection drives, so the trash view keeps its rows unselectable rather
    // than offering a checkbox with nothing to apply.
    ...(isDeletedView ? [] : [selectColumn]),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => (
        <SkillSortableHeader
          label="Skill"
          isSorted={column.getIsSorted()}
          onToggle={() => column.toggleSorting(column.getIsSorted() === "asc")}
        />
      ),
      size: 420,
      cell: ({ row }) => {
        const skill = row.original;
        const repo = parseRepoFromSourceRef(skill.sourceRef);
        return (
          <div className="flex min-w-0 items-center gap-3">
            <SkillSourceIcon
              repo={repo}
              builtIn={skill.sourceType === "built_in"}
              appIconLogo={appIconLogo}
            />
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
      size: 100,
      header: ({ column }) => (
        // Right padding keeps the right-aligned value from sitting flush
        // against the Actions buttons in the next cell.
        <div className="flex justify-end pr-6">
          <SkillSortableHeader
            label="Uses"
            isSorted={column.getIsSorted()}
            onToggle={() =>
              column.toggleSorting(column.getIsSorted() === "asc")
            }
          />
        </div>
      ),
      cell: ({ row }) => (
        <div className="flex justify-end pr-6">
          <SkillUsageSummary
            usageCount={row.original.usageCount}
            usageUserCount={row.original.usageUserCount}
            lastUsedAt={row.original.lastUsedAt}
            label={`View usage for ${row.original.name}`}
            onClick={() => router.push(skillUsageHref(row.original.id))}
          />
        </div>
      ),
    },
    {
      id: "actions",
      size: 200,
      header: () => <div className="pl-4 text-right">Actions</div>,
      cell: ({ row }) => (
        <div className="flex justify-end pl-4">
          {renderSkillActions(row.original)}
        </div>
      ),
    },
  ];

  if (isSkillsLoadError) {
    return (
      <PageLayout title="Skills" description={SKILLS_DESCRIPTION} tabs={tabs}>
        <QueryLoadError
          title="Couldn't load your skills"
          onRetry={() => refetchSkills()}
        />
      </PageLayout>
    );
  }

  return (
    <>
      <PageLayout
        title="Skills"
        description={SKILLS_DESCRIPTION}
        tabs={tabs}
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
        <TableCardView storageKey="archestra-skills-view" defaultMode="table">
          {showEmptyState ? (
            <SkillsEmptyState />
          ) : (
            <>
              <div className="mb-3 flex flex-col gap-2">
                <FilterBar
                  onClearFilters={hasActiveFilters ? clearFilters : undefined}
                  actions={!isDeletedView ? <TableCardViewToggle /> : undefined}
                >
                  <SearchInput
                    isLoading={isFetching}
                    paramName="search"
                    className={filterSearchClass}
                  />
                  {(mcpSkillsEnabled || pluginSkillsEnabled) &&
                    !isDeletedView && (
                      <Select value={kind} onValueChange={setKindFilter}>
                        <SelectTrigger
                          size="sm"
                          aria-label="Filter by skill source"
                          className={filterControlClass({
                            active: kind !== "all",
                          })}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent
                          position="popper"
                          side="bottom"
                          align="start"
                        >
                          <SelectItem value="all">All kinds</SelectItem>
                          <SelectItem value="standalone">
                            Standalone skills
                          </SelectItem>
                          {mcpSkillsEnabled && (
                            <SelectItem value="mcp">MCP skills</SelectItem>
                          )}
                          {pluginSkillsEnabled && (
                            <SelectItem value="plugin">
                              Skills from plugins
                            </SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                    )}
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
                  {showStandaloneSkills && sourceRepos.length > 0 && (
                    <Select
                      value={sourceRepo || "all"}
                      onValueChange={(value) =>
                        setSourceRepoFilter(value === "all" ? "" : value)
                      }
                    >
                      <SelectTrigger
                        size="sm"
                        aria-label="Filter by repository"
                        className={filterControlClass({
                          active: Boolean(sourceRepo),
                        })}
                      >
                        <SelectValue placeholder="All repositories">
                          {sourceRepo ? (
                            <span className="flex min-w-0 items-center gap-2">
                              <span aria-hidden>
                                <RepositoryOwnerIcon repo={sourceRepo} />
                              </span>
                              <span className="truncate">{sourceRepo}</span>
                            </span>
                          ) : (
                            <span>All repositories</span>
                          )}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All repositories</SelectItem>
                        {sourceRepos.map((repo) => (
                          <SelectItem
                            key={repo}
                            value={repo}
                            icon={
                              <span aria-hidden>
                                <RepositoryOwnerIcon repo={repo} />
                              </span>
                            }
                          >
                            {repo}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </FilterBar>
                <ActiveFilterBadges adminPermission={{ skill: ["admin"] }} />
              </div>

              <div className="space-y-6">
                {showStandaloneSection && (
                  <section
                    className="space-y-3"
                    aria-label={showStandaloneHeading ? undefined : "Skills"}
                    aria-labelledby={
                      showStandaloneHeading
                        ? "standalone-skills-title"
                        : undefined
                    }
                  >
                    {showStandaloneHeading && (
                      <h2
                        id="standalone-skills-title"
                        className="text-sm font-medium uppercase tracking-wide text-muted-foreground"
                      >
                        {isDeletedView ? "Deleted skills" : "Standalone skills"}
                      </h2>
                    )}

                    <BulkActions
                      count={selectedSkills.length}
                      noun="skill"
                      countTestId={E2eTestId.SkillsBulkSelectionCount}
                      onClear={clearSelection}
                      busy={isFetchingAllMatching}
                      selectAllMatching={{
                        total: totalSkills,
                        pageFullySelected:
                          items.length > 0 &&
                          pageSelection.length === items.length,
                        active: allMatchingSelected,
                        onSelectAll: () => setEscalatedFor(filterSignature),
                        matchDescription: search
                          ? "match this search query"
                          : "match the current filters",
                      }}
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
                    </BulkActions>

                    <SkillCollection
                      forceTable={isDeletedView}
                      items={items}
                      columns={columns}
                      getRowId={(skill) => skill.id}
                      renderCard={(skill) => {
                        const repo = parseRepoFromSourceRef(skill.sourceRef);
                        return (
                          <TableCard
                            key={skill.id}
                            icon={
                              <SkillSourceIcon
                                repo={repo}
                                builtIn={skill.sourceType === "built_in"}
                                appIconLogo={appIconLogo}
                              />
                            }
                            title={
                              <Link href={`/skills/${skill.id}`}>
                                {skill.name}
                              </Link>
                            }
                            description={skill.description}
                            actions={renderSkillActions(skill)}
                            {...cardSelection(skill)}
                            selectionLabel={`Select ${skill.name}`}
                            footer={
                              <div className="flex items-center justify-between gap-3">
                                <span>
                                  {skill.fileCount}{" "}
                                  {skill.fileCount === 1 ? "file" : "files"}
                                </span>
                                <span>
                                  {skill.usageCount}{" "}
                                  {skill.usageCount === 1 ? "use" : "uses"}
                                </span>
                              </div>
                            }
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <ResourceVisibilityBadge
                                scope={skill.scope}
                                teams={skill.teams}
                                users={skill.users}
                                authorId={skill.authorId}
                                authorName={skill.authorName}
                                currentUserId={currentUserId}
                                showSelfAsMe
                              />
                              {skill.templated ? (
                                <Badge variant="outline">
                                  <Braces className="mr-1 h-3 w-3" />
                                  <span>templated</span>
                                </Badge>
                              ) : null}
                            </div>
                          </TableCard>
                        );
                      }}
                      isLoading={isFetching}
                      emptyIcon={Sparkles}
                      emptyMessage="No standalone skills yet."
                      hasActiveFilters={hasActiveFilters}
                      filteredEmptyMessage={
                        isDeletedView
                          ? "No deleted skills found."
                          : "No standalone skills match the current filters."
                      }
                      onClearFilters={clearFilters}
                      manualPagination
                      manualSorting
                      sorting={sorting}
                      onSortingChange={handleSortingChange}
                      pagination={{
                        pageIndex,
                        pageSize,
                        total: totalSkills,
                      }}
                      onPaginationChange={handlePaginationChange}
                      onRowClick={
                        isDeletedView
                          ? undefined
                          : (skill) => router.push(`/skills/${skill.id}`)
                      }
                      rowSelection={effectiveRowSelection}
                      onRowSelectionChange={onRowSelectionChange}
                      fixedWidthColumnIds={[
                        "visibility",
                        "files",
                        "usageCount",
                      ]}
                      flexibleColumnIds={["name"]}
                    />
                  </section>
                )}

                {showMcpSection && (
                  <ExternalMcpSkillsSection
                    skills={visibleExternalSkills}
                    showWhenEmpty={kind === "mcp"}
                    isLoading={isExternalSkillsFetching}
                  />
                )}

                {showPluginSection && (
                  <PluginSkillsSection
                    skills={visiblePluginSkills}
                    showWhenEmpty={kind === "plugin"}
                    isLoading={isPluginSkillsFetching}
                  />
                )}
              </div>
            </>
          )}
        </TableCardView>
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
    </>
  );
}

const selectColumn = createSelectColumn<SkillItem>({
  rowLabel: (row) => `Select ${row.name}`,
  allLabel: "Select all skills on this page",
});

function SkillSourceIcon({
  repo,
  builtIn,
  appIconLogo,
}: {
  repo: string | null;
  builtIn: boolean;
  appIconLogo: string;
}) {
  if (builtIn) {
    return (
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/30"
        aria-hidden
      >
        <img src={appIconLogo} alt="" className="size-6 object-contain" />
      </span>
    );
  }
  if (repo) {
    return (
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/30"
        aria-hidden
      >
        <RepositoryOwnerIcon repo={repo} className="size-6" />
      </span>
    );
  }
  return (
    <span
      className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/30 text-muted-foreground"
      aria-hidden
    >
      <BookOpen className="size-4" />
    </span>
  );
}

function SkillsEmptyState() {
  return (
    <EmptyState
      className="min-h-[60vh]"
      icon={BookOpen}
      title="No skills yet"
      description="A skill is a set of instructions and files. Agents pick the right one by name and follow it on demand."
      action={
        <PermissionButton permissions={{ skill: ["create"] }} asChild>
          <Link href="/skills/new">
            <Plus className="mr-2 h-4 w-4" />
            Add your first skill
          </Link>
        </PermissionButton>
      }
    />
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
