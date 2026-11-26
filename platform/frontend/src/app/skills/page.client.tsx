"use client";

import {
  type archestraApiTypes,
  E2eTestId,
  GIT_PROVIDER_LABELS,
} from "@archestra/shared";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
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
  Puzzle,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { RowClickShield } from "@/components/agent-pages/row-click-shield";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { EntityLabelFilter } from "@/components/entity-label-filter";
import {
  CollectionFilters,
  FilterBar,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import { LabelTags } from "@/components/label-tags";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { PageLayout } from "@/components/page-layout";
import {
  PERMANENT_DELETE_LABEL,
  permanentDeleteRowAction,
} from "@/components/permanent-delete";
import { QueryLoadError } from "@/components/query-load-error";
import { RepositoryOwnerIcon } from "@/components/repository-owner-icon";
import {
  RESOURCE_ACCESS_FILTER_PARAMS,
  ResourceAccessFilter,
} from "@/components/resource-access-filter";
import { ResourceListActions } from "@/components/resource-list-actions";
import {
  ActiveFilterBadges,
  ResourceDeletedStatusFilter,
  useScopeFilterParams,
} from "@/components/resource-scope-filter";
import { SearchInput } from "@/components/search-input";
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
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
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
import {
  useHasPermissions,
  useScopedCapabilities,
  useSession,
} from "@/lib/auth/auth.query";
import { holdsItemGrant } from "@/lib/auth/auth.utils";
import { ACTION_LABEL, notYoursToChange } from "@/lib/design/resource-lexicon";
import {
  useSkillLabelKeys,
  useSkillLabelValues,
} from "@/lib/entity-labels.query";
import { useAppIconLogo } from "@/lib/hooks/use-app-name";
import { useBulkCardSelection } from "@/lib/hooks/use-bulk-card-selection";
import {
  useBulkSelection,
  useControlledRowSelection,
} from "@/lib/hooks/use-bulk-selection";
import { useIsGlobalAdmin } from "@/lib/organization.query";
import {
  type SkillUsageReference,
  useAllMatchingSkills,
  useBulkDeleteSkills,
  useExternalMcpSkills,
  usePermanentlyDeleteSkill,
  usePluginSkills,
  useRestoreSkill,
  useSkillSourceRepos,
  useSkillsList,
  useSkillsPaginated,
} from "@/lib/skills/skill.query";
import {
  parseRepoFromSourceRef,
  repositoryLabel,
} from "@/lib/skills/skill-source";
import { computeCanModifySkill } from "@/lib/skills/use-skill-access";
import { useMyTeams } from "@/lib/teams/team.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { PluginSourceIcon } from "../plugins/_parts/plugin-source-icon";
import {
  DeleteSkillDialog,
  skillDeleteDescription,
} from "./_parts/delete-skill-dialog";
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
import { SkillSourceGlyph } from "./_parts/skill-source-glyph";
import { SkillUsageDialog } from "./_parts/skill-usage-dialog";
import { SkillUsageSummary } from "./_parts/skill-usage-summary";
import { SkillVersionHistoryDialog } from "./_parts/skill-version-history-dialog";
import { useSingleFlight } from "./_parts/use-single-flight";

type SkillItem = archestraApiTypes.GetSkillsResponses["200"]["data"][number];
type ExternalSkill =
  archestraApiTypes.GetExternalMcpSkillsResponses["200"][number];
type PluginSkill = archestraApiTypes.GetPluginSkillsResponses["200"][number];
type ListedSkill =
  | {
      source: "standalone";
      key: string;
      name: string;
      usageCount: number;
      skill: SkillItem;
    }
  | {
      source: "external_mcp";
      key: string;
      name: string;
      usageCount: number;
      skill: ExternalSkill;
    }
  | {
      source: "plugin";
      key: string;
      name: string;
      usageCount: number;
      skill: PluginSkill;
    };
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
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const appIconLogo = useAppIconLogo();

  const pageIndex = Number(searchParams.get("page") || "1") - 1;
  const pageSize = Number(searchParams.get("pageSize") || DEFAULT_TABLE_LIMIT);
  const search = searchParams.get("search") || "";
  const sourceRepo = searchParams.get("sourceRepo") || "";
  const importedIds = searchParams.get("imported")?.split(",").filter(Boolean);
  const hasImportFilter = Boolean(importedIds?.length);
  // Label filtering is server-side, so the value rides the list query.
  const labelsFilter = searchParams.get("labels") || undefined;
  const scopeFilter = useScopeFilterParams();
  // The deleted view is listed only for a reader who manages every skill
  // (`skill:update` at `*`, the grant the backend asks for). A `?status=deleted`
  // that anyone else arrives with (a shared link, a bookmark from before a
  // role change) is dropped from the URL below instead of being sent: the
  // request could only come back refused, and nothing on the page could fix
  // it.
  const isDeletedRequested = searchParams.get("status") === "deleted";
  const { data: isSkillAdmin, isPending: isSkillAdminPending } =
    useHasPermissions({ skill: ["update"] }, "*");
  const isDeletedView = isDeletedRequested && isSkillAdmin === true;
  // Whether the reader may see the deleted view is not known yet, so neither
  // list is asked for: the page would otherwise load the active skills under
  // a URL that asks for the deleted ones, or send a request it may be refused.
  const isDeletedViewUndecided = isDeletedRequested && isSkillAdminPending;
  useEffect(() => {
    if (!isDeletedRequested || isSkillAdminPending || isSkillAdmin) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("status");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  }, [
    isDeletedRequested,
    isSkillAdminPending,
    isSkillAdmin,
    searchParams,
    router,
    pathname,
  ]);

  type SkillSortBy = NonNullable<
    NonNullable<archestraApiTypes.GetSkillsData["query"]>["sortBy"]
  >;
  const sortBy =
    (searchParams.get("sortBy") as SkillSortBy | null) || "usageCount";
  const sortDirection =
    (searchParams.get("sortDirection") as "asc" | "desc" | null) || "desc";
  const scopedCapabilities = useScopedCapabilities();
  const { data: canReadPlugins } = useHasPermissions({ plugin: ["read"] });
  const hasPluginReadGrant =
    scopedCapabilities.data?.some(
      (grant) => grant.resource === "plugin" && grant.action === "read",
    ) ?? false;
  const canOpenPluginDetails = (pluginId: string) =>
    holdsItemGrant({
      grants: scopedCapabilities.data,
      resource: "plugin",
      action: "read",
      id: pluginId,
    });
  const pluginSkillsEnabled = canReadPlugins === true || hasPluginReadGrant;
  const kindParam = searchParams.get("kind");
  const requestedKind: SkillKind = hasImportFilter
    ? "standalone"
    : kindParam === "standalone" ||
        kindParam === "mcp" ||
        kindParam === "plugin"
      ? kindParam
      : "all";
  const kind: SkillKind = isDeletedView
    ? "standalone"
    : requestedKind === "plugin" && !pluginSkillsEnabled
      ? "all"
      : requestedKind;
  const showStandaloneSkills = kind === "all" || kind === "standalone";
  const showMcpSkills =
    !isDeletedView &&
    !isDeletedViewUndecided &&
    (kind === "all" || kind === "mcp");
  const showPluginSkills =
    pluginSkillsEnabled &&
    !isDeletedView &&
    !isDeletedViewUndecided &&
    (kind === "all" || kind === "plugin");
  // Name-based edit links may target a skill beyond the visible page, so keep
  // their existing complete standalone list until the name has resolved.
  const openEdit = searchParams.get("openEdit");
  const isStandalonePaginatedView =
    !isDeletedView && kind === "standalone" && !openEdit;
  const usesPaginatedSkills = isDeletedView || isStandalonePaginatedView;

  /**
   * Everything that narrows the table, with the page itself left out — the
   * visible page and "every matching skill" differ only by limit/offset.
   */
  const listFilters = {
    // The table shows names and descriptions, never the SKILL.md body.
    includeContent: false,
    search: search || undefined,
    sourceRepo: sourceRepo || undefined,
    skillIds: hasImportFilter ? importedIds : undefined,
    labels: labelsFilter,
    scope: scopeFilter.scope,
    teamIds: scopeFilter.teamIds,
    authorIds: scopeFilter.authorIds,
    excludeAuthorIds: scopeFilter.excludeAuthorIds,
    excludeOtherPersonalSkills: scopeFilter.excludeOtherPersonal,
    access: scopeFilter.access,
    sharedWith: scopeFilter.sharedWith,
    owner: scopeFilter.owner,
    status: isDeletedView ? ("deleted" as const) : undefined,
    sortBy,
    sortDirection,
  };

  const {
    data: skills,
    isPending: isDeletedSkillsPending,
    isFetching: isDeletedSkillsFetching,
    isLoadingError: isDeletedSkillsLoadError,
    error: deletedSkillsError,
    refetch: refetchSkills,
  } = useSkillsPaginated(
    {
      limit: pageSize,
      offset: pageIndex * pageSize,
      ...listFilters,
    },
    {
      enabled: usesPaginatedSkills && !isDeletedViewUndecided,
      toastOnError: false,
    },
  );
  const {
    data: activeSkills = [],
    isPending: isActiveSkillsPending,
    isFetching: isActiveSkillsFetching,
    isLoadingError: isActiveSkillsLoadError,
    error: activeSkillsError,
    refetch: refetchActiveSkills,
  } = useSkillsList(listFilters, {
    enabled:
      !isDeletedView &&
      !isDeletedViewUndecided &&
      showStandaloneSkills &&
      !isStandalonePaginatedView,
    toastOnError: false,
  });
  const isFetching = usesPaginatedSkills
    ? isDeletedSkillsFetching
    : isActiveSkillsFetching;
  const isSkillsLoadError = usesPaginatedSkills
    ? isDeletedSkillsLoadError
    : isActiveSkillsLoadError;
  const skillsLoadError = usesPaginatedSkills
    ? deletedSkillsError
    : activeSkillsError;
  const { data: sourceReposData } = useSkillSourceRepos();
  const sourceRepos = sourceReposData?.repos ?? [];
  const {
    data: externalSkills = [],
    isPending: isExternalSkillsPending,
    isFetching: isExternalSkillsFetching,
  } = useExternalMcpSkills({
    enabled: showMcpSkills,
  });
  const visibleExternalSkills = sourceRepo
    ? []
    : filterExternalMcpSkills({
        skills: externalSkills,
        search,
        scope: scopeFilter.scope,
      });
  const {
    data: pluginSkills = [],
    isPending: isPluginSkillsPending,
    isFetching: isPluginSkillsFetching,
  } = usePluginSkills({ enabled: showPluginSkills });
  const visiblePluginSkills = sourceRepo
    ? []
    : filterPluginSkills({
        skills: pluginSkills,
        search,
        scope: scopeFilter.scope,
      });
  const restoreSkill = useRestoreSkill();
  // One restore per skill at a time. The request settles only once the list
  // has been read again (see `useRestoreSkill`), so the id stays held until
  // the row has left the deleted view; the ref refuses a second click that
  // lands before the first one has re-rendered the button as busy.
  const restoringIdsRef = useRef(new Set<string>());
  const [restoringIds, setRestoringIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const handleRestore = useCallback(
    (id: string) => {
      const held = restoringIdsRef.current;
      if (held.has(id)) return;
      held.add(id);
      setRestoringIds(new Set(held));
      void restoreSkill
        .mutateAsync(id)
        // A rejection is reported by the mutation's own `onError`.
        .catch(() => null)
        .finally(() => {
          held.delete(id);
          setRestoringIds(new Set(held));
        });
    },
    [restoreSkill],
  );
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
      params.delete("imported");
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
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [permanentlyDeletingSkill, setPermanentlyDeletingSkill] =
    useState<SkillItem | null>(null);
  const [historySkillId, setHistorySkillId] = useState<string | null>(null);
  const [usageSkill, setUsageSkill] = useState<{
    reference: SkillUsageReference;
    name: string;
    allTime: { usageCount: number; lastUsedAt: string | null };
  } | null>(null);
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  // Resolved once for the whole table, then applied per row: the scope check
  // is a pure function precisely so a table cell does not have to call hooks.
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: userTeams } = useMyTeams({ enabled: !!canReadTeams });
  const userTeamIdSet = new Set((userTeams ?? []).map((team) => team.id));

  const standaloneSkills = usesPaginatedSkills
    ? (skills?.data ?? [])
    : activeSkills;
  const items: ListedSkill[] = [
    ...(showStandaloneSkills
      ? standaloneSkills.map((skill) => ({
          source: "standalone" as const,
          key: `standalone:${skill.id}`,
          name: skill.name,
          usageCount: skill.usageCount,
          skill,
        }))
      : []),
    ...(showMcpSkills
      ? visibleExternalSkills.map((skill) => ({
          source: "external_mcp" as const,
          key: `external_mcp:${skill.mcpServerId}:${skill.id}`,
          name: skill.name,
          usageCount: skill.usageCount,
          skill,
        }))
      : []),
    ...(showPluginSkills
      ? visiblePluginSkills.map((skill) => ({
          source: "plugin" as const,
          key: `plugin:${skill.pluginId}:${skill.skillPath}`,
          name: skill.name,
          usageCount: skill.usageCount,
          skill,
        }))
      : []),
  ];
  const bulkDeleteSkills = useBulkDeleteSkills();
  /**
   * An escalation is remembered as the filters it was made under, so changing
   * a filter drops it rather than silently re-pointing "all 203 skills" at a
   * different 203. It also keeps the offer honest: it is only ever shown when
   * the whole matching set fits in one bulk request, so an escalation that
   * survived a filter change could otherwise claim more than it can act on.
   */
  const filterSignature = JSON.stringify({ kind, ...listFilters });
  const [escalatedFor, setEscalatedFor] = useState<string | null>(null);
  const allMatchingSelected =
    usesPaginatedSkills && escalatedFor === filterSignature;
  const {
    data: allMatchingSkills,
    isFetching: isAllMatchingFetching,
    isError: isAllMatchingError,
  } = useAllMatchingSkills(listFilters, { enabled: allMatchingSelected });
  const selection = useBulkSelection({
    rows: items,
    getId: (row) => row.key,
    canSelect: canBulkActOnSkill,
    filterSignature,
    matchDescription: search
      ? "match this search query"
      : "match the current filters",
  });
  const { effectiveRowSelection, onRowSelectionChange, rangeSelection } =
    useControlledRowSelection({
      rowSelection: selection.rowSelection,
      setRowSelection: selection.setRowSelection,
      rows: items,
      getRowId: (row) => row.key,
      canSelect: canBulkActOnSkill,
      allMatchingSelected,
      clearEscalation: () => setEscalatedFor(null),
    });
  const visibleRows = items.filter((item) =>
    selection.pageRowIds.includes(item.key),
  );
  const cardSelection = useBulkCardSelection({
    rows: visibleRows,
    getRowId: (row) => row.key,
    rowSelection: effectiveRowSelection,
    setRowSelection: onRowSelectionChange,
    canSelect: canBulkActOnSkill,
    rangeSelection,
  });
  const pageSelectedSkills = selection.selected
    .filter((item) => item.source === "standalone")
    .map((item) => item.skill);
  const selectedSkills = allMatchingSelected
    ? (allMatchingSkills ?? pageSelectedSkills)
    : pageSelectedSkills;
  const clearSelection = () => {
    selection.clearSelection();
    setEscalatedFor(null);
  };
  // One request per confirmation: a second click before the button has
  // re-rendered as busy would repeat the delete, and the repeat reports every
  // skill as not found.
  const confirmBulkDelete = useSingleFlight(async () => {
    const result = await bulkDeleteSkills
      .mutateAsync(selectedSkills.map((skill) => skill.id))
      // A rejection is reported by the mutation's own `onError`.
      .catch(() => null);
    if (!result || result.succeeded.length === 0) return;
    clearSelection();
    setBulkDeleteOpen(false);
  });

  // Deep-link support: /skills?openEdit=<name> opens the matching skill's page
  // (e.g. from the chat SkillPill). The name resolves to an id once the items
  // it was searched by have loaded.
  useEffect(() => {
    if (!openEdit || standaloneSkills.length === 0) return;
    const match = standaloneSkills.find((skill) => skill.name === openEdit);
    if (!match) return;
    router.replace(`/skills/${match.id}`);
  }, [openEdit, standaloneSkills, router]);
  const pagination = skills?.pagination;
  const totalStandaloneSkills = usesPaginatedSkills
    ? (pagination?.total ?? 0)
    : activeSkills.length;
  const totalSkills = usesPaginatedSkills
    ? totalStandaloneSkills
    : items.length;
  const hasActiveFilters =
    hasImportFilter ||
    !!search ||
    !!sourceRepo ||
    Boolean(labelsFilter) ||
    scopeFilter.hasActiveScopeFilters ||
    isDeletedView ||
    kind !== "all";
  const hasVisibleSkills =
    (showStandaloneSkills && totalStandaloneSkills > 0) ||
    (showMcpSkills && visibleExternalSkills.length > 0) ||
    (showPluginSkills && visiblePluginSkills.length > 0);
  /**
   * Nothing has come back yet on this view, so the page cannot tell whether it
   * is about to show a list or an empty state.
   *
   * Rendering the list branch meanwhile — which is what happens when the only
   * signal is `showEmptyState` — puts the filter bar, the table and the "Add
   * new skill" button on screen for a moment and then replaces the lot with
   * the empty state, measured at ~250ms of a layout that was never real.
   *
   * `isPending` alone would not do: a disabled query stays pending forever, so
   * the MCP and plugin lists would hold this true whenever their toggles are
   * off. Pairing it with `isFetching` reads "pending *and* actually in flight",
   * which is only true during a first load of a query that is switched on.
   */
  const isInitialSkillsLoad =
    isDeletedViewUndecided ||
    ((usesPaginatedSkills ? isDeletedSkillsPending : isActiveSkillsPending) &&
      isFetching) ||
    (showMcpSkills && isExternalSkillsPending && isExternalSkillsFetching) ||
    (showPluginSkills && isPluginSkillsPending && isPluginSkillsFetching);
  const showEmptyState =
    // A list that failed to load is not an empty one.
    !isSkillsLoadError &&
    !isFetching &&
    !(showMcpSkills && isExternalSkillsFetching) &&
    !(showPluginSkills && isPluginSkillsFetching) &&
    !hasVisibleSkills &&
    !hasActiveFilters;
  const clearFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of [
      "search",
      "imported",
      "sourceRepo",
      "scope",
      "teamIds",
      "authorIds",
      "excludeAuthorIds",
      ...RESOURCE_ACCESS_FILTER_PARAMS,
      "status",
      "kind",
      "labels",
    ]) {
      params.delete(key);
    }
    params.set("page", "1");
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  }, [pathname, router, searchParams]);

  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("page", String(newPagination.pageIndex + 1));
      params.set("pageSize", String(newPagination.pageSize));
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const renderSkillActions = (skill: SkillItem) => {
    const actionModel = getSkillActionModel(skill.id);
    const chatAction = skillAction(actionModel, "chat");
    const editAction = skillAction(actionModel, "edit");
    const usageAction = skillAction(actionModel, "usage");
    const historyAction = skillAction(actionModel, "history");
    const deleteAction = skillAction(actionModel, "delete");
    const canModify = computeCanModifySkill({
      scopedGrants: scopedCapabilities.data ?? [],
      skill,
      isAdmin: !!isSkillAdmin,
      isTeamAdmin: false,
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
            disabled: !canModify || restoringIds.has(skill.id),
            disabledTooltip: canModify ? "Restoring…" : notYours,
            onClick: () => handleRestore(skill.id),
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
        permissionScope={"id" in skill ? skill.id : undefined}
        actions={actions}
        dropdownActions={dropdownActions}
        itemName={skill.name}
      />
    );
  };

  const renderListedSkillActions = (item: ListedSkill) => {
    if (item.source === "standalone") return renderSkillActions(item.skill);

    const skill = item.skill;
    const usageReference: SkillUsageReference =
      item.source === "external_mcp"
        ? {
            kind: "externalMcp",
            mcpServerId: item.skill.mcpServerId,
            uri: item.skill.uri,
          }
        : {
            kind: "plugin",
            pluginId: item.skill.pluginId,
            skillPath: item.skill.skillPath,
          };
    const usageAction: TableRowAction = {
      icon: <ChartColumn className="h-4 w-4" />,
      label: "Usage",
      permissions:
        item.source === "external_mcp"
          ? {
              skill: ["read"],
              mcpServerInstallation: ["read"],
            }
          : undefined,
      onClick: () =>
        setUsageSkill({
          reference: usageReference,
          name: skill.name,
          allTime: {
            usageCount: skill.usageCount,
            lastUsedAt: skill.lastUsedAt,
          },
        }),
    };
    const actions: TableRowAction[] =
      item.source === "external_mcp"
        ? [
            {
              icon: <MessageSquare className="h-4 w-4" />,
              label: "Chat",
              permissions: { chat: ["read", "create"] },
              href: externalSkillChatHref(item.skill),
            },
            usageAction,
            {
              icon: <Server className="h-4 w-4" />,
              label: "Manage MCP server",
              href: `/mcp/registry/${item.skill.catalogId}`,
            },
          ]
        : [
            usageAction,
            {
              icon: <Puzzle className="h-4 w-4" />,
              label: "Manage plugin",
              href: `/plugins/${item.skill.pluginId}`,
              permissions: { plugin: ["update"] },
              permissionScope: item.skill.pluginId,
            },
          ];

    return (
      <TableRowActions
        permissionScope={"id" in skill ? skill.id : undefined}
        actions={actions}
        itemName={skill.name}
      />
    );
  };

  const columns: ColumnDef<ListedSkill>[] = [
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
      cell: ({ row }) => (
        <ListedSkillName item={row.original} appIconLogo={appIconLogo} />
      ),
    },
    {
      id: "source",
      size: 220,
      header: "Source",
      cell: ({ row }) => {
        const source = listedSkillSource(row.original);
        if (
          row.original.source === "plugin" &&
          canOpenPluginDetails(row.original.skill.pluginId)
        ) {
          return (
            <RowClickShield className="min-w-0">
              <Link
                href={`/plugins/${row.original.skill.pluginId}`}
                className="block truncate text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                title={source.label}
              >
                {source.label}
              </Link>
            </RowClickShield>
          );
        }
        return (
          <span
            className="block truncate text-sm text-muted-foreground"
            title={source.label}
          >
            {source.isRepo ? (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
                {source.label}
              </code>
            ) : (
              source.label
            )}
          </span>
        );
      },
    },
    {
      id: "files",
      size: 90,
      header: () => <div className="text-right">Files</div>,
      cell: ({ row }) => {
        const fileCount = listedSkillFileCount(row.original);
        return (
          <div className="text-right text-sm text-muted-foreground">
            {fileCount} {fileCount === 1 ? "file" : "files"}
          </div>
        );
      },
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
            usageCount={row.original.skill.usageCount}
            usageUserCount={row.original.skill.usageUserCount}
            lastUsedAt={row.original.skill.lastUsedAt}
            label={`View usage for ${row.original.skill.name}`}
            onClick={() => {
              const item = row.original;
              if (item.source === "standalone") {
                router.push(skillUsageHref(item.skill.id));
                return;
              }
              setUsageSkill({
                reference:
                  item.source === "external_mcp"
                    ? {
                        kind: "externalMcp",
                        mcpServerId: item.skill.mcpServerId,
                        uri: item.skill.uri,
                      }
                    : {
                        kind: "plugin",
                        pluginId: item.skill.pluginId,
                        skillPath: item.skill.skillPath,
                      },
                name: item.skill.name,
                allTime: {
                  usageCount: item.skill.usageCount,
                  lastUsedAt: item.skill.lastUsedAt,
                },
              });
            }}
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
          {renderListedSkillActions(row.original)}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageLayout
        title="Skills"
        description={SKILLS_DESCRIPTION}
        actionButton={
          <div className="flex items-center gap-2">
            {!showEmptyState && !isInitialSkillsLoad && (
              <PermissionButton
                permissions={{ skill: ["create"] }}
                size="sm"
                asChild
              >
                <Link href="/skills/new">
                  <Plus className="h-4 w-4" />
                  Add new skill
                </Link>
              </PermissionButton>
            )}
            <ResourceListActions resource="skill" />
          </div>
        }
      >
        <TableCardView storageKey="archestra-skills-view" defaultMode="table">
          {isInitialSkillsLoad ? null : showEmptyState ? (
            <SkillsEmptyState />
          ) : (
            <>
              <CollectionFilters>
                {hasImportFilter && (
                  <InlineNotice variant="info" className="-mt-2">
                    <Info />
                    <span className="font-medium">Just imported</span>
                    <InlineNoticeText>
                      Showing only the skills created by this import.
                    </InlineNoticeText>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      onClick={() => {
                        const params = new URLSearchParams(
                          searchParams.toString(),
                        );
                        params.delete("imported");
                        params.delete("page");
                        router.push(`${pathname}?${params.toString()}`, {
                          scroll: false,
                        });
                      }}
                    >
                      <span>Show all skills</span>
                    </Button>
                  </InlineNotice>
                )}
                <FilterBar
                  leading={!hasImportFilter}
                  onClearFilters={hasActiveFilters ? clearFilters : undefined}
                  actions={!isDeletedView ? <TableCardViewToggle /> : undefined}
                  search={
                    <SearchInput
                      isLoading={isFetching}
                      paramName="search"
                      className={filterSearchClass}
                    />
                  }
                >
                  {!isDeletedView && (
                    <ResourceAccessFilter resource="skill" noun="skills" />
                  )}
                  {!isDeletedView && (
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
                        <SelectItem value="mcp">MCP skills</SelectItem>
                        {pluginSkillsEnabled && (
                          <SelectItem value="plugin">
                            Skills from plugins
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  )}

                  {/* The same grant the backend asks of `status=deleted`
                    (`skill:update` at `*`), so the filter is offered only to a
                    reader the deleted list will answer. `skill:delete` alone
                    is held by anyone who can delete their own skill. */}
                  <ResourceDeletedStatusFilter
                    deletePermission={{ skill: ["update"] }}
                    deletePermissionScope="*"
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
                              <span className="truncate">
                                {repositoryLabel(sourceRepo)}
                              </span>
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
                            {repositoryLabel(repo)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <EntityLabelFilter
                    useLabelKeys={useSkillLabelKeys}
                    useLabelValues={useSkillLabelValues}
                    className={filterControlClass({
                      active: Boolean(labelsFilter),
                    })}
                  />
                </FilterBar>
                <ActiveFilterBadges />
              </CollectionFilters>

              {isSkillsLoadError ? (
                // In place of the table only: the filters above stay, since a
                // filter is as likely as the network to be what failed, and
                // clearing it is the way back. Given the error, the panel
                // tells a refusal from a lost connection.
                <QueryLoadError
                  title="Couldn't load your skills"
                  error={skillsLoadError}
                  onRetry={() =>
                    usesPaginatedSkills
                      ? refetchSkills()
                      : refetchActiveSkills()
                  }
                  className="min-h-[40vh]"
                />
              ) : (
                <section className="space-y-3" aria-label="Skills">
                  <BulkActions
                    count={selectedSkills.length}
                    noun="skill"
                    countTestId={E2eTestId.SkillsBulkSelectionCount}
                    onClear={clearSelection}
                    busy={
                      allMatchingSelected &&
                      (isAllMatchingFetching || isAllMatchingError)
                    }
                    selectAllMatching={
                      usesPaginatedSkills
                        ? {
                            ...selection.selectAllMatching,
                            total: skills?.pagination.total ?? 0,
                            active: allMatchingSelected,
                            onSelectAll: () => setEscalatedFor(filterSignature),
                          }
                        : selection.selectAllMatching
                    }
                  >
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
                    getRowId={(item) => item.key}
                    renderCard={(item) => {
                      const fileCount = listedSkillFileCount(item);
                      const standalone =
                        item.source === "standalone" ? item.skill : null;
                      const href = listedSkillHref(item);
                      return (
                        <TableCard
                          key={item.key}
                          icon={
                            <ListedSkillIcon
                              item={item}
                              appIconLogo={appIconLogo}
                            />
                          }
                          title={
                            <span className="flex min-w-0 items-center gap-2">
                              <Link href={href} className="truncate">
                                {item.skill.name}
                              </Link>
                              <ListedSkillSourceBadge
                                item={item}
                                canOpenPluginDetails={
                                  item.source === "plugin" &&
                                  canOpenPluginDetails(item.skill.pluginId)
                                }
                              />
                              {standalone ? (
                                <LabelTags labels={standalone.labels} />
                              ) : null}
                            </span>
                          }
                          description={item.skill.description}
                          actions={renderListedSkillActions(item)}
                          onNavigate={
                            isDeletedView
                              ? undefined
                              : () => router.push(listedSkillHref(item))
                          }
                          {...cardSelection(item)}
                          selectionLabel={`Select ${item.skill.name}`}
                          footer={
                            <div className="flex items-center justify-between gap-3">
                              <span>
                                {fileCount} {fileCount === 1 ? "file" : "files"}
                              </span>
                              <span>
                                {item.skill.usageCount}{" "}
                                {item.skill.usageCount === 1 ? "use" : "uses"}
                              </span>
                            </div>
                          }
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            {standalone?.templated ? (
                              <Badge variant="outline">
                                <Braces className="mr-1 h-3 w-3" />
                                <span>templated</span>
                              </Badge>
                            ) : null}
                            {item.source === "plugin" &&
                            !item.skill.pluginEnabled ? (
                              <Badge variant="outline">Plugin disabled</Badge>
                            ) : null}
                          </div>
                        </TableCard>
                      );
                    }}
                    isLoading={
                      isFetching ||
                      (showMcpSkills && isExternalSkillsFetching) ||
                      (showPluginSkills && isPluginSkillsFetching)
                    }
                    emptyIcon={Sparkles}
                    emptyMessage="No skills yet."
                    hasActiveFilters={hasActiveFilters}
                    filteredEmptyMessage={
                      isDeletedView
                        ? "No deleted skills found."
                        : "No skills match the current filters."
                    }
                    onClearFilters={clearFilters}
                    manualPagination={usesPaginatedSkills}
                    manualSorting={usesPaginatedSkills}
                    sorting={sorting}
                    onSortingChange={handleSortingChange}
                    pagination={{ pageIndex, pageSize, total: totalSkills }}
                    onPaginationChange={handlePaginationChange}
                    onRowClick={
                      isDeletedView
                        ? undefined
                        : (item) => router.push(listedSkillHref(item))
                    }
                    rowSelection={effectiveRowSelection}
                    onRowSelectionChange={onRowSelectionChange}
                    onPageRowIdsChange={selection.onPageRowIdsChange}
                    rangeSelection={rangeSelection}
                    fixedWidthColumnIds={["source", "files", "usageCount"]}
                    flexibleColumnIds={["name"]}
                  />
                </section>
              )}
            </>
          )}
        </TableCardView>
      </PageLayout>

      {bulkDeleteOpen && (
        <DeleteConfirmDialog
          open={bulkDeleteOpen}
          onOpenChange={setBulkDeleteOpen}
          title={selectedSkills.length === 1 ? "Delete skill" : "Delete skills"}
          description={skillDeleteDescription({
            subject:
              selectedSkills.length === 1
                ? "1 skill"
                : `${selectedSkills.length} skills`,
            count: selectedSkills.length,
            canOpenDeletedView: isSkillAdmin === true,
          })}
          isPending={bulkDeleteSkills.isPending}
          onConfirm={confirmBulkDelete}
          confirmLabel={
            selectedSkills.length === 1 ? "Delete skill" : "Delete skills"
          }
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
          skillRef={usageSkill.reference}
          skillName={usageSkill.name}
          allTime={usageSkill.allTime}
          open
          onOpenChange={(open) => !open && setUsageSkill(null)}
        />
      )}
    </>
  );
}

const selectColumn = createSelectColumn<ListedSkill>({
  rowLabel: (row) => `Select ${row.skill.name}`,
  allLabel: "Select all skills on this page",
  canSelect: canBulkActOnSkill,
  disabledReason: (row) =>
    row.source === "external_mcp"
      ? "MCP skills are managed through their MCP server"
      : "Plugin skills are managed through their plugin",
});

function canBulkActOnSkill(item: ListedSkill) {
  return item.source === "standalone";
}

function filterExternalMcpSkills({
  skills,
  search,
  scope,
}: {
  skills: ExternalSkill[];
  search?: string;
  scope?: "personal" | "team" | "org";
}) {
  const needle = search?.trim().toLowerCase();
  return skills.filter(
    (skill) =>
      (!scope || skill.scope === scope) &&
      (!needle ||
        skill.name.toLowerCase().includes(needle) ||
        skill.description.toLowerCase().includes(needle) ||
        skill.serverName.toLowerCase().includes(needle)),
  );
}

function filterPluginSkills({
  skills,
  search,
  scope,
}: {
  skills: PluginSkill[];
  search?: string;
  scope?: "personal" | "team" | "org";
}) {
  const needle = search?.trim().toLowerCase();
  return skills.filter(
    (skill) =>
      (!scope || skill.scope === scope) &&
      (!needle ||
        skill.name.toLowerCase().includes(needle) ||
        skill.description.toLowerCase().includes(needle) ||
        skill.pluginName.toLowerCase().includes(needle)),
  );
}

function listedSkillHref(item: ListedSkill) {
  if (item.source === "standalone") return `/skills/${item.skill.id}`;
  if (item.source === "external_mcp") {
    return `/skills/external/${item.skill.id}?mcpServerId=${item.skill.mcpServerId}`;
  }
  const query = item.skill.skillPath
    ? `?skillPath=${encodeURIComponent(item.skill.skillPath)}`
    : "";
  return `/skills/plugins/${item.skill.pluginId}${query}`;
}

function externalSkillChatHref(skill: ExternalSkill) {
  const params = new URLSearchParams({
    mcp_skill_id: skill.id,
    mcp_server_id: skill.mcpServerId,
    mcp_skill_uri: skill.uri,
    mcp_skill_name: skill.name,
    mcp_server_name: skill.serverName,
    mcp_skill_display_name: `${skill.serverName} [${skill.scope}:${skill.mcpServerId.slice(0, 8)}] / ${skill.name}`,
  });
  return `/chat/new?${params.toString()}`;
}

function listedSkillFileCount(item: ListedSkill) {
  return item.source === "external_mcp"
    ? (item.skill.resources?.length ?? 1)
    : item.skill.fileCount;
}

function ListedSkillName({
  item,
  appIconLogo,
}: {
  item: ListedSkill;
  appIconLogo: string;
}) {
  const standalone = item.source === "standalone" ? item.skill : null;
  const compatibility =
    item.source === "standalone" || item.source === "plugin"
      ? item.skill.compatibility
      : null;

  return (
    <div className="flex min-w-0 items-center gap-3">
      <ListedSkillIcon item={item} appIconLogo={appIconLogo} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-medium">{item.skill.name}</span>
          {compatibility && (
            <RowClickShield className="inline-flex shrink-0">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="img"
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard focus reveals the compatibility note without implying a click action
                    tabIndex={0}
                    aria-label="Compatibility notes"
                    className="inline-flex size-5 cursor-help items-center justify-center rounded-sm text-amber-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:text-amber-400"
                  >
                    <Info className="size-3.5" />
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  {compatibility}
                </TooltipContent>
              </Tooltip>
            </RowClickShield>
          )}
          {standalone?.labels ? <LabelTags labels={standalone.labels} /> : null}
          {standalone?.githubSyncInterval && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  role="img"
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard focus reveals the sync details without implying a click action
                  tabIndex={0}
                  aria-label={
                    standalone.lastSyncError ? "Sync failed" : "Kept in sync"
                  }
                  className={cn(
                    "inline-flex size-5 shrink-0 cursor-help items-center justify-center rounded-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    standalone.lastSyncError && "text-destructive",
                  )}
                >
                  <RefreshCw className="size-3.5" />
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {`${SYNC_INTERVAL_LABELS[standalone.githubSyncInterval]} from ${GIT_PROVIDER_LABELS[standalone.sourceProvider ?? "github"]}; read-only until disconnected.`}
                {standalone.lastSyncError
                  ? ` Last sync failed: ${standalone.lastSyncError}`
                  : ` Last synced: ${formatRelativeTimeFromNow(
                      standalone.lastSyncedAt,
                      { neverLabel: "not yet" },
                    )}.`}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {item.skill.description && (
          <div className="truncate text-xs text-muted-foreground">
            {item.skill.description}
          </div>
        )}
      </div>
      {standalone?.templated && (
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
      {item.source === "plugin" && !item.skill.pluginEnabled && (
        <Badge variant="outline" className="shrink-0">
          Disabled
        </Badge>
      )}
    </div>
  );
}

function ListedSkillSourceBadge({
  item,
  canOpenPluginDetails,
}: {
  item: ListedSkill;
  canOpenPluginDetails: boolean;
}) {
  const source = listedSkillSource(item);
  if (
    item.source === "standalone" &&
    item.skill.sourceType !== "built_in" &&
    !source.isRepo
  ) {
    return null;
  }
  const badge = (
    <Badge
      variant="secondary"
      title={source.label}
      className="inline-flex max-w-56 shrink overflow-hidden font-normal"
    >
      <span className={cn("truncate", source.isRepo && "font-mono")}>
        {source.label}
      </span>
    </Badge>
  );
  return item.source === "plugin" && canOpenPluginDetails ? (
    <RowClickShield className="inline-flex min-w-0 shrink">
      <Link
        href={`/plugins/${item.skill.pluginId}`}
        className="min-w-0 rounded-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {badge}
      </Link>
    </RowClickShield>
  ) : (
    badge
  );
}

function listedSkillSource(item: ListedSkill): {
  label: string;
  isRepo: boolean;
} {
  if (item.source === "external_mcp") {
    return { label: `${item.skill.serverName} · MCP`, isRepo: false };
  }
  if (item.source === "plugin") {
    return { label: `${item.skill.pluginName} · Plugin`, isRepo: false };
  }
  if (item.skill.sourceType === "built_in") {
    return { label: "Built in", isRepo: false };
  }
  const repo = parseRepoFromSourceRef(
    item.skill.sourceRef,
    item.skill.sourceOrigin,
    item.skill.sourceProvider,
  );
  return repo
    ? { label: repositoryLabel(repo), isRepo: true }
    : {
        label: item.skill.sourceType === "github" ? "Git" : "Manual",
        isRepo: false,
      };
}

function ListedSkillIcon({
  item,
  appIconLogo,
}: {
  item: ListedSkill;
  appIconLogo: string;
}) {
  if (item.source === "external_mcp") {
    return (
      <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted/30">
        <McpCatalogIcon
          icon={item.skill.icon}
          catalogId={item.skill.catalogId}
          size={20}
        />
      </span>
    );
  }
  if (item.source === "plugin") {
    return <PluginSourceIcon plugin={item.skill} />;
  }
  return (
    <span
      className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/30"
      aria-hidden
    >
      <SkillSourceGlyph skill={item.skill} appIconLogo={appIconLogo} />
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
        <PermissionButton permissions={{ skill: ["create"] }} size="sm" asChild>
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

  // One request per confirmation: a second click before the button has
  // re-rendered as busy would ask to destroy a skill that is already gone.
  const handleDelete = useSingleFlight(async () => {
    const result = await permanentlyDeleteSkill.mutateAsync(skill.id);
    if (result) {
      onOpenChange(false);
    }
  });

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
