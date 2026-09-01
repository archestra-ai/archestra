"use client";

import { type archestraApiTypes, E2eTestId } from "@archestra/shared";
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
import { useCallback, useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import {
  CollectionFilters,
  FilterBar,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
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
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import { useIsGlobalAdmin } from "@/lib/organization.query";
import {
  type SkillUsageReference,
  useBulkDeleteSkills,
  useExternalMcpSkills,
  usePermanentlyDeleteSkill,
  usePluginSkills,
  useRestoreSkill,
  useSkillSourceRepos,
  useSkillsList,
  useSkillsPaginated,
} from "@/lib/skills/skill.query";
import { parseRepoFromSourceRef } from "@/lib/skills/skill-source";
import { computeCanModifySkill } from "@/lib/skills/use-skill-access";
import { useMyTeams } from "@/lib/teams/team.query";
import { cn } from "@/lib/utils";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { PluginSourceIcon } from "../plugins/_parts/plugin-source-icon";
import { BulkVisibilityDialog } from "./_parts/bulk-visibility-dialog";
import { DeleteSkillDialog } from "./_parts/delete-skill-dialog";
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
import { SkillUsageDialog } from "./_parts/skill-usage-dialog";
import { SkillUsageSummary } from "./_parts/skill-usage-summary";
import { SkillVersionHistoryDialog } from "./_parts/skill-version-history-dialog";

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
    isFetching: isDeletedSkillsFetching,
    isLoadingError: isDeletedSkillsLoadError,
    refetch: refetchSkills,
  } = useSkillsPaginated(
    {
      limit: pageSize,
      offset: pageIndex * pageSize,
      ...listFilters,
    },
    { enabled: isDeletedView, toastOnError: false },
  );
  const {
    data: activeSkills = [],
    isFetching: isActiveSkillsFetching,
    isLoadingError: isActiveSkillsLoadError,
    refetch: refetchActiveSkills,
  } = useSkillsList(listFilters, {
    enabled: !isDeletedView && showStandaloneSkills,
    toastOnError: false,
  });
  const isFetching = isDeletedView
    ? isDeletedSkillsFetching
    : isActiveSkillsFetching;
  const isSkillsLoadError = isDeletedView
    ? isDeletedSkillsLoadError
    : isActiveSkillsLoadError;
  const { data: sourceReposData } = useSkillSourceRepos();
  const sourceRepos = sourceReposData?.repos ?? [];
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
  const [bulkVisibilityOpen, setBulkVisibilityOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [permanentlyDeletingSkill, setPermanentlyDeletingSkill] =
    useState<SkillItem | null>(null);
  const [historySkillId, setHistorySkillId] = useState<string | null>(null);
  const [usageSkill, setUsageSkill] = useState<{
    reference: SkillUsageReference;
    name: string;
  } | null>(null);
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

  const standaloneSkills = isDeletedView ? (skills?.data ?? []) : activeSkills;
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
  const filterSignature = JSON.stringify(listFilters);
  const selection = useBulkSelection({
    rows: items,
    getId: (row) => row.key,
    canSelect: canBulkActOnSkill,
    filterSignature,
    matchDescription: search
      ? "match this search query"
      : "match the current filters",
  });
  const visibleRows = items.filter((item) =>
    selection.pageRowIds.includes(item.key),
  );
  const cardSelection = useBulkCardSelection({
    rows: visibleRows,
    getRowId: (row) => row.key,
    rowSelection: selection.rowSelection,
    setRowSelection: selection.setRowSelection,
    canSelect: canBulkActOnSkill,
    rangeSelection: selection.rangeSelection,
  });
  const selectedSkills = selection.selected
    .filter((item) => item.source === "standalone")
    .map((item) => item.skill);
  const clearSelection = selection.clearSelection;

  // Deep-link support: /skills?openEdit=<name> opens the matching skill's page
  // (e.g. from the chat SkillPill). The name resolves to an id once the items
  // it was searched by have loaded.
  const openEdit = searchParams.get("openEdit");
  useEffect(() => {
    if (!openEdit || standaloneSkills.length === 0) return;
    const match = standaloneSkills.find((skill) => skill.name === openEdit);
    if (!match) return;
    router.replace(`/skills/${match.id}`);
  }, [openEdit, standaloneSkills, router]);
  const pagination = skills?.pagination;
  const totalStandaloneSkills = isDeletedView
    ? (pagination?.total ?? 0)
    : activeSkills.length;
  const totalSkills = isDeletedView ? totalStandaloneSkills : items.length;
  const hasActiveFilters =
    !!search ||
    !!sourceRepo ||
    scopeFilter.hasActiveScopeFilters ||
    isDeletedView ||
    ((mcpSkillsEnabled || pluginSkillsEnabled) &&
      !isDeletedView &&
      kind !== "all");
  const hasVisibleSkills =
    (showStandaloneSkills && totalStandaloneSkills > 0) ||
    (showMcpSkills && visibleExternalSkills.length > 0) ||
    (showPluginSkills && visiblePluginSkills.length > 0);
  const showEmptyState =
    !isFetching &&
    !(showMcpSkills && isExternalSkillsFetching) &&
    !(showPluginSkills && isPluginSkillsFetching) &&
    !hasVisibleSkills &&
    !hasActiveFilters;
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
              permissions: { plugin: ["admin"] },
            },
          ];

    return <TableRowActions actions={actions} itemName={skill.name} />;
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
        <ListedSkillName
          item={row.original}
          appName={appName}
          appIconLogo={appIconLogo}
        />
      ),
    },
    {
      id: "visibility",
      size: 130,
      header: "Visibility",
      cell: ({ row }) => {
        const item = row.original;
        const standalone = item.source === "standalone" ? item.skill : null;
        return (
          <ResourceVisibilityBadge
            scope={item.skill.scope}
            teams={standalone?.teams}
            users={standalone?.users}
            authorId={standalone?.authorId ?? currentUserId}
            authorName={standalone?.authorName ?? session?.user?.name}
            currentUserId={currentUserId}
            showSelfAsMe
          />
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

  if (isSkillsLoadError) {
    return (
      <PageLayout title="Skills" description={SKILLS_DESCRIPTION}>
        <QueryLoadError
          title="Couldn't load your skills"
          onRetry={() =>
            isDeletedView ? refetchSkills() : refetchActiveSkills()
          }
        />
      </PageLayout>
    );
  }

  return (
    <>
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
        <TableCardView storageKey="archestra-skills-view" defaultMode="table">
          {showEmptyState ? (
            <SkillsEmptyState />
          ) : (
            <>
              <CollectionFilters>
                <FilterBar
                  leading
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
              </CollectionFilters>

              <section className="space-y-3" aria-label="Skills">
                <BulkActions
                  count={selectedSkills.length}
                  noun="skill"
                  countTestId={E2eTestId.SkillsBulkSelectionCount}
                  onClear={clearSelection}
                  selectAllMatching={selection.selectAllMatching}
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
                              appName={appName}
                            />
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
                          <ResourceVisibilityBadge
                            scope={item.skill.scope}
                            teams={standalone?.teams}
                            users={standalone?.users}
                            authorId={standalone?.authorId ?? currentUserId}
                            authorName={
                              standalone?.authorName ?? session?.user?.name
                            }
                            currentUserId={currentUserId}
                            showSelfAsMe
                          />
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
                  manualPagination={isDeletedView}
                  manualSorting={isDeletedView}
                  sorting={sorting}
                  onSortingChange={handleSortingChange}
                  pagination={{ pageIndex, pageSize, total: totalSkills }}
                  onPaginationChange={handlePaginationChange}
                  onRowClick={
                    isDeletedView
                      ? undefined
                      : (item) => router.push(listedSkillHref(item))
                  }
                  rowSelection={selection.rowSelection}
                  onRowSelectionChange={selection.setRowSelection}
                  onPageRowIdsChange={selection.onPageRowIdsChange}
                  rangeSelection={selection.rangeSelection}
                  fixedWidthColumnIds={["visibility", "files", "usageCount"]}
                  flexibleColumnIds={["name"]}
                />
              </section>
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

      {usageSkill && (
        <SkillUsageDialog
          skillRef={usageSkill.reference}
          skillName={usageSkill.name}
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
  appName,
  appIconLogo,
}: {
  item: ListedSkill;
  appName: string;
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
          <ListedSkillSourceBadge item={item} appName={appName} />
          {standalone?.githubSyncInterval && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className={cn(
                    "shrink-0 gap-1",
                    standalone.lastSyncError && "text-destructive",
                  )}
                >
                  <RefreshCw className="h-3 w-3" />
                  synced
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                {SYNC_INTERVAL_LABELS[standalone.githubSyncInterval]} from
                GitHub; read-only until disconnected.
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
      {compatibility && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="gap-1">
              <Info className="h-3 w-3" />
              compatibility
            </Badge>
          </TooltipTrigger>
          <TooltipContent>{compatibility}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function ListedSkillSourceBadge({
  item,
  appName,
}: {
  item: ListedSkill;
  appName: string;
}) {
  if (item.source === "external_mcp") {
    return (
      <Badge
        variant="secondary"
        title={`${item.skill.serverName} · MCP`}
        className="inline-flex max-w-56 shrink items-center gap-1 overflow-hidden font-normal"
      >
        <span className="truncate">{item.skill.serverName}</span>
        <span aria-hidden className="shrink-0 text-muted-foreground">
          ·
        </span>
        <span className="shrink-0">MCP</span>
      </Badge>
    );
  }
  if (item.source === "plugin") {
    const repo =
      item.skill.sourceMarketplaceRepo ?? item.skill.sourceRepo ?? null;
    const isOpenAppa =
      item.skill.pluginName.toLowerCase() === "openappa" &&
      repo?.toLowerCase() === "archestra-ai/openappa";
    if (isOpenAppa) {
      return (
        <Badge
          variant="secondary"
          title="OpenAPPA"
          className="inline-flex max-w-48 shrink items-center overflow-hidden font-normal"
        >
          <span className="truncate">OpenAPPA</span>
        </Badge>
      );
    }
    return (
      <Badge
        variant="secondary"
        title={`${item.skill.pluginName} · Plugin`}
        className="inline-flex max-w-56 shrink items-center gap-1 overflow-hidden font-normal"
      >
        <span className="truncate">{item.skill.pluginName}</span>
        <span aria-hidden className="shrink-0 text-muted-foreground">
          ·
        </span>
        <span className="shrink-0">Plugin</span>
      </Badge>
    );
  }
  if (item.skill.sourceType === "built_in") {
    return (
      <Badge
        variant="secondary"
        title={appName}
        className="shrink-0 font-normal"
      >
        <span>{appName}</span>
      </Badge>
    );
  }
  const repo = parseRepoFromSourceRef(item.skill.sourceRef);
  return repo ? (
    <Badge
      variant="secondary"
      title={repo}
      className="inline-flex max-w-48 shrink overflow-hidden font-normal"
    >
      <span className="truncate font-mono">{repo}</span>
    </Badge>
  ) : null;
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
    <SkillSourceIcon
      repo={parseRepoFromSourceRef(item.skill.sourceRef)}
      builtIn={item.skill.sourceType === "built_in"}
      appIconLogo={appIconLogo}
    />
  );
}

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
