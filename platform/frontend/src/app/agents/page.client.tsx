"use client";

import {
  type archestraApiTypes,
  E2eTestId,
  MAX_BULK_IDS,
} from "@archestra/shared";
import type {
  ColumnDef,
  RowSelectionState,
  SortingState,
} from "@tanstack/react-table";
import {
  Bot,
  ChevronDown,
  ChevronUp,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { A2aRemoteAgentActions } from "@/components/a2a-remote-agent-actions";
import { A2aRemoteAgentScopeSelector } from "@/components/a2a-remote-agent-scope-selector";
import {
  AgentAccessBadges,
  AgentLastUsedFooter,
} from "@/components/agent-card-meta";
import { AgentIcon } from "@/components/agent-icon";
import { AgentNameCell } from "@/components/agent-name-cell";
import {
  AGENT_PAGE_CONFIGS,
  agentConfigureHref,
  agentDetailHref,
  agentNewHref,
  resolveLegacyAgentDialogRedirect,
} from "@/components/agent-pages/agent-page-config";
import {
  openRowOnPlainClick,
  RowClickShield,
} from "@/components/agent-pages/row-click-shield";
import { computeCanModifyAgent } from "@/components/agent-pages/use-agent-access";
import { AgentProviderIndicator } from "@/components/agent-provider-indicator";
import { AgentVersionHistoryDialog } from "@/components/agent-version-history-dialog";
import { BulkVisibilityDialog } from "@/components/bulk-visibility-dialog";
import { RuntimeCapableIndicator } from "@/components/chat/runtime-capable-indicator";
import { CloneAgentDialog } from "@/components/clone-agent-dialog";
import {
  DefaultAgentTag,
  offersDefaultPin,
  resolveDefaultAgentBadge,
} from "@/components/default-agent-tag";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  CollectionFilters,
  FilterBar,
  filterSearchClass,
} from "@/components/filter-bar";
import { ImportAgentDialog } from "@/components/import-agent-dialog";
import { LabelTags } from "@/components/label-tags";
import { PageLayout } from "@/components/page-layout";
import { PERMANENT_DELETE_LABEL } from "@/components/permanent-delete";
import { PermissionRequirementHint } from "@/components/permission-requirement-hint";
import {
  isProviderApiKeyId,
  ProviderKeyFilterSelect,
} from "@/components/provider-key-filter-select";
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
  TableCard,
  TableCardList,
  TableCardView,
  TableCardViewContent,
  TableCardViewToggle,
} from "@/components/table-card-view";
import { Badge } from "@/components/ui/badge";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import { DEFAULT_SORT_BY, DEFAULT_SORT_DIRECTION } from "@/consts";
import { getA2aRemoteAgentDeleteDescription } from "@/lib/a2a-remote-agent-delete";
import { a2aRemoteAgentDetailHref } from "@/lib/a2a-remote-agent-route";
import {
  type A2aRemoteAgent,
  useBulkUpdateA2aRemoteAgentVisibility,
  useDeleteA2aRemoteAgent,
} from "@/lib/a2a-remote-agents.query";
import {
  useBulkDeleteProfiles,
  useBulkUpdateProfileVisibility,
  useDefaultAgentId,
  useDeleteProfile,
  useExportAgent,
  usePermanentlyDeleteProfile,
  usePinAgent,
  useRestoreProfile,
  useUpdateDefaultAgentId,
} from "@/lib/agent.query";
import {
  useAgentCatalog,
  useAllMatchingAgentCatalog,
} from "@/lib/agent-catalog.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  type BulkOutcome,
  reportBulkOutcome,
  runBulkAction,
} from "@/lib/bulk-action";
import { FIELD_LABEL } from "@/lib/design/resource-lexicon";
import { useEnvironments } from "@/lib/environment.query";
import { useBulkCardSelection } from "@/lib/hooks/use-bulk-card-selection";
import { useControlledRowSelection } from "@/lib/hooks/use-bulk-selection";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useQueryParamsAdapter } from "@/lib/hooks/use-query-params-adapter";
import {
  useDefaultEnvironment,
  useOrganization,
} from "@/lib/organization.query";
import { useMyTeams } from "@/lib/teams/team.query";
import { resolveCatalogEnvironmentLabel } from "../mcp/registry/_parts/catalog-environment-label";
import { AgentActions } from "./agent-actions";
import { ConvertToSkillDialog } from "./convert-to-skill-dialog";

type AgentsInitialData = {
  agents: archestraApiTypes.GetAgentCatalogResponses["200"] | null;
  pinnedAgents: archestraApiTypes.GetAgentCatalogResponses["200"] | null;
  teams: archestraApiTypes.GetTeamsResponses["200"]["data"];
};

type AgentListRow =
  archestraApiTypes.GetAgentCatalogResponses["200"]["data"][number];
type AgentData = Extract<AgentListRow, { type: "agent" }>["value"];
type ExternalAgentData = Extract<AgentListRow, { type: "external" }>["value"];

function getAgentListRowId(row: AgentListRow) {
  return `${row.type}:${row.value.id}`;
}

function combineBulkOutcomes(outcomes: readonly BulkOutcome[]): BulkOutcome {
  return {
    succeeded: outcomes.flatMap((outcome) => outcome.succeeded),
    failed: outcomes.flatMap((outcome) => outcome.failed),
  };
}

function partitionAgentRows(rows: readonly AgentListRow[]) {
  const agents: AgentData[] = [];
  const externalAgents: ExternalAgentData[] = [];
  for (const row of rows) {
    if (row.type === "agent") agents.push(row.value);
    else externalAgents.push(row.value);
  }
  return { agents, externalAgents };
}

export default function AgentsPage({
  initialData,
}: {
  initialData?: AgentsInitialData;
}) {
  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <Agents initialData={initialData} />
      </ErrorBoundary>
    </div>
  );
}

function SortIcon({
  isSorted,
}: {
  isSorted:
    | NonNullable<
        archestraApiTypes.GetAgentCatalogData["query"]
      >["sortDirection"]
    | false;
}) {
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

function Agents({ initialData }: { initialData?: AgentsInitialData }) {
  const queryParamsAdapter = useQueryParamsAdapter();
  const {
    searchParams,
    pageIndex,
    pageSize,
    updateQueryParams,
    setPagination,
  } = useDataTableQueryParams({ queryParamsAdapter });
  const router = useRouter();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data: canCreateAgent } = useHasPermissions({ agent: ["create"] });
  const { data: canManageExternalAgents } = useHasPermissions({
    agent: ["read"],
    agentSettings: ["update"],
  });

  // Get pagination/filter params from URL
  const nameFilter = searchParams.get("name") || "";
  const sortByFromUrl = searchParams.get("sortBy") as
    | "name"
    | "createdAt"
    | "team"
    | null;
  const sortDirectionFromUrl = searchParams.get("sortDirection") as
    | "asc"
    | "desc"
    | null;
  const scopeFilter = useScopeFilterParams({
    includeBuiltIn: true,
    queryParamsAdapter,
  });
  const labelsFromUrl = searchParams.get("labels");
  const statusFromUrl = searchParams.get("status") as
    | "active"
    | "deleted"
    | null;
  const providerApiKeyIdFromUrl = searchParams.get("providerApiKeyId");
  const providerApiKeyIdFilter =
    providerApiKeyIdFromUrl === "organization-default" ||
    isProviderApiKeyId(providerApiKeyIdFromUrl)
      ? providerApiKeyIdFromUrl
      : undefined;

  // Default sorting
  const sortBy = sortByFromUrl || DEFAULT_SORT_BY;
  const sortDirection = sortDirectionFromUrl || DEFAULT_SORT_DIRECTION;
  const isDeletedView = statusFromUrl === "deleted";

  const catalogFilters = {
    sortBy,
    sortDirection,
    name: nameFilter || undefined,
    scope: scopeFilter.scope,
    teamIds: scopeFilter.teamIds,
    authorIds: scopeFilter.authorIds,
    excludeAuthorIds: scopeFilter.excludeAuthorIds,
    excludeOtherPersonalAgents: scopeFilter.excludeOtherPersonal,
    labels: labelsFromUrl || undefined,
    status: statusFromUrl || undefined,
    providerApiKeyId: providerApiKeyIdFilter,
  } satisfies Omit<
    NonNullable<archestraApiTypes.GetAgentCatalogData["query"]>,
    "limit" | "offset"
  >;

  const {
    data: catalogResponse,
    isPending,
    isFetching,
    isLoadingError: isAgentsLoadError,
    refetch: refetchAgents,
  } = useAgentCatalog({
    limit: pageSize,
    offset: pageIndex * pageSize,
    initialData: initialData?.agents ?? undefined,
    initialDataExcludeOtherPersonalAgents: true,
    initialDataPinned: isDeletedView ? undefined : false,
    pinned: isDeletedView ? undefined : false,
    ...catalogFilters,
  });
  const {
    data: pinnedAgentsResponse,
    isPending: isPinnedPending,
    isFetching: isPinnedFetching,
    isLoadingError: isPinnedAgentsLoadError,
    refetch: refetchPinnedAgents,
  } = useAgentCatalog({
    limit: 100,
    offset: 0,
    initialData: initialData?.pinnedAgents ?? undefined,
    initialDataExcludeOtherPersonalAgents: true,
    initialDataPinned: true,
    initialDataLimit: 100,
    enabled: !isDeletedView,
    ...catalogFilters,
    status: undefined,
    pinned: true,
  });
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });

  const { data: userTeams } = useMyTeams({
    enabled: !!canReadTeams,
  });

  const { data: isAgentAdmin } = useHasPermissions({ agent: ["admin"] });
  const { data: isAgentTeamAdmin } = useHasPermissions({
    agent: ["team-admin"],
  });
  const userTeamIdSet = new Set((userTeams ?? []).map((t) => t.id));

  const { data: environmentList } = useEnvironments();
  const environments = useMemo(
    () => environmentList?.environments ?? [],
    [environmentList],
  );
  const defaultEnvironment = useDefaultEnvironment();
  // Every agent sits in the default environment until someone defines another,
  // so the column would be a wall of one repeated value.
  const showEnvironmentColumn = environments.length > 0;

  // Users can always create personal agents, no team requirement needed

  const [sorting, setSorting] = useState<SortingState>([
    { id: sortBy, desc: sortDirection === "desc" },
  ]);

  // Sync sorting state with URL params
  useEffect(() => {
    setSorting([{ id: sortBy, desc: sortDirection === "desc" }]);
  }, [sortBy, sortDirection]);

  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null);
  const [deletingExternalAgent, setDeletingExternalAgent] =
    useState<A2aRemoteAgent | null>(null);
  const [permanentlyDeletingAgent, setPermanentlyDeletingAgent] =
    useState<AgentData | null>(null);

  const [cloningAgent, setCloningAgent] = useState<AgentData | null>(null);
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const exportAgent = useExportAgent();
  const restoreAgent = useRestoreProfile();
  const { data: personalDefaultAgentId } = useDefaultAgentId();
  const { data: organization } = useOrganization();
  // Exactly one agent starts this viewer's new chats, so exactly one row is
  // badged — badging a personal pin AND the organization default would put two
  // answers on screen to a question that has one.
  const effectiveDefault = resolveDefaultAgentBadge({
    personalDefaultAgentId,
    organizationDefaultAgentId: organization?.defaultAgentId,
  });
  const updateDefaultAgentId = useUpdateDefaultAgentId();
  const permanentlyDeleteAgent = usePermanentlyDeleteProfile();

  // The row's scope check travels with the id: it is computed per row, and the
  // dialog's restore is an update that has to answer to it.
  const [history, setHistory] = useState<{
    id: string;
    canModify: boolean;
  } | null>(null);
  const [convertingAgent, setConvertingAgent] = useState<AgentData | null>(
    null,
  );

  // Create/edit/view used to be dialogs on this page, opened from
  // `?create=true`, `?edit=<id>` and `?view=<id>`; those links still arrive
  // (bookmarks, other pages) and now land on the routed pages.
  useEffect(() => {
    const redirect = resolveLegacyAgentDialogRedirect("agent", searchParams);
    if (redirect) router.replace(redirect);
  }, [searchParams, router]);

  // Update URL when sorting changes
  const handleSortingChange = useCallback(
    (updater: SortingState | ((old: SortingState) => SortingState)) => {
      const newSorting =
        typeof updater === "function" ? updater(sorting) : updater;
      setSorting(newSorting);

      if (newSorting.length > 0) {
        updateQueryParams({
          page: "1",
          sortBy: newSorting[0].id,
          sortDirection: newSorting[0].desc ? "desc" : "asc",
        });
      } else {
        updateQueryParams({
          page: "1",
          sortBy: null,
          sortDirection: null,
        });
      }
    },
    [sorting, updateQueryParams],
  );

  // Update URL when pagination changes
  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      setPagination(newPagination);
    },
    [setPagination],
  );

  const pinnedRows: AgentListRow[] = isDeletedView
    ? []
    : (pinnedAgentsResponse?.data ?? []).filter(
        (row): row is Extract<AgentListRow, { type: "agent" }> =>
          row.type === "agent",
      );
  const unpinnedRows: AgentListRow[] = catalogResponse?.data ?? [];
  const rows = isDeletedView ? unpinnedRows : [...pinnedRows, ...unpinnedRows];
  const regularTotal =
    (catalogResponse?.totals.agents ?? 0) +
    (isDeletedView ? 0 : (pinnedAgentsResponse?.totals.agents ?? 0));
  const pagination = {
    pageIndex,
    pageSize,
    total: catalogResponse?.pagination.total ?? 0,
  };
  const showLoading =
    (isPending ||
      isFetching ||
      (!isDeletedView && (isPinnedPending || isPinnedFetching))) &&
    rows.length === 0;
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const bulkDeleteAgents = useBulkDeleteProfiles();
  const deleteExternalAgent = useDeleteA2aRemoteAgent();
  const bulkDeleteExternalAgents = useDeleteA2aRemoteAgent({ notify: false });
  const [bulkVisibilityOpen, setBulkVisibilityOpen] = useState(false);
  const [bulkVisibilityRows, setBulkVisibilityRows] = useState<AgentListRow[]>(
    [],
  );
  const [bulkVisibilityContext, setBulkVisibilityContext] = useState<{
    filterSignature: string;
    allMatching: boolean;
  } | null>(null);
  const bulkAgentVisibility = useBulkUpdateProfileVisibility();
  const bulkExternalAgentVisibility = useBulkUpdateA2aRemoteAgentVisibility();
  const pinAgent = usePinAgent();
  // Derived from what is on screen rather than read straight out of
  // `rowSelection`: the table is server-paginated, so ids left behind by
  // another page drop out of both the count and the request. The trash view
  // renders no checkbox column, so it never surfaces a bar either.
  const filterSignature = JSON.stringify(catalogFilters);
  const [escalatedFor, setEscalatedFor] = useState<string | null>(null);
  const allMatchingSelected = escalatedFor === filterSignature;
  const allMatchingContextRef = useRef({
    filterSignature,
    selected: allMatchingSelected,
  });
  allMatchingContextRef.current = {
    filterSignature,
    selected: allMatchingSelected,
  };
  const canSelectRow = (row: AgentListRow) =>
    row.type === "agent" || !!canManageExternalAgents;
  const { effectiveRowSelection, onRowSelectionChange, rangeSelection } =
    useControlledRowSelection({
      rowSelection,
      setRowSelection,
      rows,
      getRowId: getAgentListRowId,
      allMatchingSelected,
      clearEscalation: () => setEscalatedFor(null),
      canSelect: canSelectRow,
    });
  const cardSelection = useBulkCardSelection({
    rows,
    getRowId: getAgentListRowId,
    rowSelection: effectiveRowSelection,
    setRowSelection: onRowSelectionChange,
    rangeSelection,
    canSelect: canSelectRow,
  });
  const {
    data: allMatching,
    isFetching: isFetchingAllMatching,
    isError: isAllMatchingError,
    refetch: refetchAllMatching,
  } = useAllMatchingAgentCatalog(catalogFilters, {
    enabled: allMatchingSelected,
  });

  useEffect(() => {
    if (!allMatchingSelected || !isAllMatchingError) return;
    toast.error("Couldn't select all matching agents", {
      id: "agents-all-matching-error",
      action: {
        label: "Retry",
        onClick: () => void refetchAllMatching(),
      },
    });
  }, [allMatchingSelected, isAllMatchingError, refetchAllMatching]);

  const pageSelection = isDeletedView
    ? []
    : rows.filter(
        (row) =>
          canSelectRow(row) &&
          effectiveRowSelection[getAgentListRowId(row)] === true,
      );
  const selectedRows =
    allMatchingSelected && allMatching
      ? allMatching.filter(canSelectRow)
      : pageSelection;
  const {
    agents: selectedRegularAgents,
    externalAgents: selectedExternalAgents,
  } = partitionAgentRows(selectedRows);
  const selectedCount = selectedRows.length;
  const bulkSelectionOverLimit = selectedCount > MAX_BULK_IDS;
  const allMatchingSelectionUnavailable =
    allMatchingSelected &&
    (isFetchingAllMatching || isAllMatchingError || bulkSelectionOverLimit);
  const {
    agents: bulkVisibilityRegularAgents,
    externalAgents: bulkVisibilityExternalAgents,
  } = partitionAgentRows(bulkVisibilityRows);
  const openBulkVisibility = async () => {
    const requestedFilterSignature = filterSignature;
    const requestedAllMatching = allMatchingSelected;
    let refreshedRows = selectedRows;
    if (requestedAllMatching) {
      const result = await refetchAllMatching();
      if (result.isError || !result.data) return;
      const currentContext = allMatchingContextRef.current;
      if (
        currentContext.filterSignature !== requestedFilterSignature ||
        !currentContext.selected
      ) {
        return;
      }
      refreshedRows = result.data.filter(canSelectRow);
    }
    if (refreshedRows.length > MAX_BULK_IDS) return;
    setBulkVisibilityRows(refreshedRows);
    setBulkVisibilityContext({
      filterSignature: requestedFilterSignature,
      allMatching: requestedAllMatching,
    });
    setBulkVisibilityOpen(true);
  };
  const openBulkDelete = () => {
    setBulkDeleteOpen(true);
    if (allMatchingSelected) void refetchAllMatching();
  };

  useEffect(() => {
    if (!bulkVisibilityOpen || !bulkVisibilityContext) {
      return;
    }
    const contextInvalid =
      bulkVisibilityContext.filterSignature !== filterSignature ||
      (bulkVisibilityContext.allMatching && !allMatchingSelected);
    const selectionRefreshing =
      bulkVisibilityContext.allMatching && isFetchingAllMatching;
    if (!contextInvalid && !selectionRefreshing) return;
    setBulkVisibilityOpen(false);
    setBulkVisibilityRows([]);
    setBulkVisibilityContext(null);
  }, [
    bulkVisibilityOpen,
    bulkVisibilityContext,
    filterSignature,
    allMatchingSelected,
    isFetchingAllMatching,
  ]);
  const selectablePageCount = rows.filter(canSelectRow).length;
  const totalSelectableCount =
    regularTotal +
    (canManageExternalAgents
      ? (catalogResponse?.totals.externalAgents ?? 0)
      : 0);
  const bulkVisibilityPermissions = {
    ...(selectedRegularAgents.length > 0 ? { agent: ["update" as const] } : {}),
    ...(selectedExternalAgents.length > 0
      ? { agentSettings: ["update" as const] }
      : {}),
  };
  const bulkDeletePermissions = {
    ...(selectedRegularAgents.length > 0 ? { agent: ["delete" as const] } : {}),
    ...(selectedExternalAgents.length > 0
      ? { agentSettings: ["update" as const] }
      : {}),
  };
  const bulkBusy =
    bulkDeleteAgents.isPending ||
    bulkDeleteExternalAgents.isPending ||
    bulkAgentVisibility.isPending ||
    bulkExternalAgentVisibility.isPending ||
    isFetchingAllMatching;
  const bulkDeleteDescription = (() => {
    const noun = selectedCount === 1 ? "agent" : "agents";
    if (selectedExternalAgents.length === 0) {
      return `Delete ${selectedCount} ${noun}? This cannot be undone.`;
    }

    const externalCount = selectedExternalAgents.length;
    const assignmentCount = selectedExternalAgents.reduce(
      (total, agent) => total + agent.assignmentCount,
      0,
    );
    const assignmentConsequence =
      assignmentCount > 0
        ? ` Their ${assignmentCount} subagent ${assignmentCount === 1 ? "assignment" : "assignments"} will also be removed.`
        : "";
    return `Delete ${selectedCount} ${noun}? This includes ${externalCount} external A2A ${externalCount === 1 ? "agent" : "agents"} and removes their stored connection ${externalCount === 1 ? "credential" : "credentials"}.${assignmentConsequence} This cannot be undone.`;
  })();
  const clearSelection = useCallback(() => {
    setRowSelection({});
    setEscalatedFor(null);
  }, []);
  const hasActiveFilters = !!(
    nameFilter ||
    scopeFilter.hasActiveScopeFilters ||
    labelsFromUrl ||
    isDeletedView ||
    providerApiKeyIdFilter
  );

  const clearFilters = useCallback(() => {
    updateQueryParams({
      page: "1",
      name: null,
      scope: null,
      teamIds: null,
      authorIds: null,
      excludeAuthorIds: null,
      labels: null,
      status: null,
      providerApiKeyId: null,
    });
  }, [updateQueryParams]);

  const renderAgentActions = (agent: AgentData) => {
    const canModify = computeCanModifyAgent({
      agent,
      isAdmin: !!isAgentAdmin,
      isTeamAdmin: !!isAgentTeamAdmin,
      currentUserId,
      userTeamIds: userTeamIdSet,
    });
    return (
      <AgentActions
        agent={agent}
        canModify={canModify}
        onEdit={(target) => router.push(agentConfigureHref("agent", target.id))}
        onView={(target) => router.push(agentDetailHref("agent", target.id))}
        onDelete={setDeletingAgentId}
        onRestore={(agentId) => {
          restoreAgent.mutate(agentId, {
            onSuccess: (data) => {
              if (!data) return;
              toast.success("Agent restored successfully");
            },
          });
        }}
        onPermanentlyDelete={setPermanentlyDeletingAgent}
        onClone={setCloningAgent}
        onConvertToSkill={setConvertingAgent}
        onTogglePin={(target) =>
          pinAgent.mutate({ id: target.id, pinned: !target.pinnedAt })
        }
        personalDefault={
          agent.agentType === "agent" &&
          !agent.builtIn &&
          offersDefaultPin({ agentId: agent.id, badge: effectiveDefault })
            ? {
                isDefault: agent.id === personalDefaultAgentId,
                onToggle: (target, makeDefault) => {
                  updateDefaultAgentId.mutate(makeDefault ? target.id : null, {
                    onSuccess: (data) => {
                      if (!data) return;
                      toast.success(
                        makeDefault
                          ? `${target.name} is now your default agent`
                          : `${target.name} is no longer your default agent`,
                      );
                    },
                  });
                },
              }
            : undefined
        }
        onHistory={(id, historyCanModify) =>
          setHistory({ id, canModify: historyCanModify })
        }
        onExport={(agentData) => {
          exportAgent.mutate(agentData.id, {
            onSuccess: (data) => {
              if (!data) return;
              const blob = new Blob([JSON.stringify(data, null, 2)], {
                type: "application/json",
              });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${agentData.name.replace(/\s+/g, "-").toLowerCase()}-agent.json`;
              a.click();
              URL.revokeObjectURL(url);
            },
          });
        }}
      />
    );
  };

  const openExternalAgent = (agent: A2aRemoteAgent) =>
    router.push(a2aRemoteAgentDetailHref(agent.id));

  const renderExternalAgentActions = (agent: A2aRemoteAgent) => (
    <A2aRemoteAgentActions
      agent={agent}
      canManage={!!canManageExternalAgents}
      onOpen={() => openExternalAgent(agent)}
      onDelete={() => setDeletingExternalAgent(agent)}
    />
  );

  const renderAgentCard = (row: AgentListRow) => {
    if (row.type === "external") {
      const agent = row.value;
      return (
        <TableCard
          key={getAgentListRowId(row)}
          testId={`a2a-remote-agent-card-${agent.id}`}
          icon={<AgentIcon size={20} />}
          title={
            <span className="flex min-w-0 items-center gap-2">
              <Link
                href={a2aRemoteAgentDetailHref(agent.id)}
                className="truncate"
              >
                {agent.name}
              </Link>
              <Badge variant="secondary" className="shrink-0">
                A2A
              </Badge>
            </span>
          }
          description={agent.description || "External A2A agent"}
          actions={renderExternalAgentActions(agent)}
          onNavigate={() => openExternalAgent(agent)}
          {...cardSelection(row)}
          selectionLabel={`Select ${agent.name}`}
          selectionDisabledTooltip="Requires permission to update external A2A agents"
          footer={<AgentLastUsedFooter lastUsedAt={agent.lastUsedAt} />}
        >
          <div className="flex flex-wrap items-center gap-2">
            <ResourceVisibilityBadge
              scope={agent.scope}
              teams={agent.teams}
              users={agent.users}
              authorId={agent.authorId}
              authorName={agent.authorName}
              currentUserId={currentUserId}
              showSelfAsMe
            />
            <Badge variant={agent.connection.enabled ? "default" : "secondary"}>
              {agent.connection.enabled ? "Enabled" : "Disabled"}
            </Badge>
            <Badge variant="outline">{agent.assignmentCount} assigned</Badge>
          </div>
        </TableCard>
      );
    }

    const agent = row.value;
    return (
      <TableCard
        key={getAgentListRowId(row)}
        icon={<AgentIcon icon={agent.icon} size={20} />}
        title={
          <span className="flex min-w-0 items-center gap-1.5">
            <Link
              href={agentDetailHref("agent", agent.id)}
              className="truncate"
            >
              {agent.name}
            </Link>
            <LabelTags labels={agent.labels} />
          </span>
        }
        description={agent.description}
        actions={renderAgentActions(agent)}
        onNavigate={
          isDeletedView
            ? undefined
            : () => router.push(agentDetailHref("agent", agent.id))
        }
        {...cardSelection(row)}
        selectionLabel={`Select ${agent.name}`}
        footer={<AgentLastUsedFooter lastUsedAt={agent.lastUsedAt} />}
      >
        <div className="flex flex-wrap items-center gap-2">
          <ResourceVisibilityBadge
            scope={agent.scope}
            teams={agent.teams}
            users={agent.users}
            authorId={agent.authorId}
            authorName={agent.authorName}
            currentUserId={currentUserId}
            showSelfAsMe
          />
          {/* Badge row, not the title line: the title shares its line with
              the action cluster and clips at phone width. */}
          {agent.runtime != null && (
            <RuntimeCapableIndicator variant="pill" runtime={agent.runtime} />
          )}
          {effectiveDefault?.agentId === agent.id ? (
            <DefaultAgentTag source={effectiveDefault.source} />
          ) : null}
          <AgentAccessBadges agent={agent} />
          <span className="ml-auto">
            <AgentProviderIndicator
              usesOrganizationDefault={!agent.llmApiKeyId && !agent.modelId}
              provider={agent.resolvedLlmProvider}
              keyName={agent.resolvedLlmProviderKeyName}
              modelName={agent.resolvedLlmModelName}
            />
          </span>
        </div>
      </TableCard>
    );
  };

  const columns: ColumnDef<AgentListRow>[] = [
    // A deleted row can only be restored or purged, neither of which this
    // selection drives, so the trash view keeps its rows unselectable.
    ...(isDeletedView
      ? []
      : [
          createSelectColumn<AgentListRow>({
            rowLabel: (row) => `Select ${row.value.name}`,
            allLabel: "Select all agents on this page",
            canSelect: canSelectRow,
            disabledReason: () =>
              "Requires permission to update external A2A agents",
          }),
        ]),
    {
      id: "name",
      accessorFn: (row) => row.value.name,
      size: 240,
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Name
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      cell: ({ row }) => {
        const item = row.original;
        if (item.type === "external") {
          const agent = item.value;
          return (
            <AgentNameCell
              name={agent.name}
              icon={<AgentIcon size={20} />}
              href={a2aRemoteAgentDetailHref(agent.id)}
              description={agent.description || "External A2A agent"}
              extraBadges={<Badge variant="secondary">A2A</Badge>}
            />
          );
        }

        const agent = item.value;
        return (
          <AgentNameCell
            name={agent.name}
            icon={<AgentIcon icon={agent.icon} size={20} />}
            // A trashed agent has no detail page: `GET /api/agents/:id`
            // filters deleted rows, so the link would land on "not found".
            href={
              agent.deletedAt ? undefined : agentDetailHref("agent", agent.id)
            }
            builtIn={agent.builtIn ?? undefined}
            description={agent.description}
            labels={agent.labels}
            extraBadges={
              <>
                {agent.runtime != null && (
                  <RuntimeCapableIndicator
                    variant="pill"
                    runtime={agent.runtime}
                  />
                )}
                {effectiveDefault?.agentId === agent.id ? (
                  <DefaultAgentTag source={effectiveDefault.source} />
                ) : null}
              </>
            }
          />
        );
      },
    },
    {
      id: "team",
      header: "Accessible to",
      enableSorting: false,
      size: 160,
      cell: ({ row }) => (
        <RowClickShield>
          <ResourceVisibilityBadge
            scope={row.original.value.scope}
            teams={row.original.value.teams}
            users={row.original.value.users}
            authorId={row.original.value.authorId}
            authorName={row.original.value.authorName}
            currentUserId={currentUserId}
            showSelfAsMe
          />
        </RowClickShield>
      ),
    },
    {
      id: "provider",
      header: "Provider",
      enableSorting: false,
      size: 80,
      cell: ({ row }) =>
        row.original.type === "external" ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <AgentProviderIndicator
            usesOrganizationDefault={
              !row.original.value.llmApiKeyId && !row.original.value.modelId
            }
            provider={row.original.value.resolvedLlmProvider}
            keyName={row.original.value.resolvedLlmProviderKeyName}
            modelName={row.original.value.resolvedLlmModelName}
          />
        ),
    },
    ...(showEnvironmentColumn
      ? [
          {
            id: "environment",
            header: FIELD_LABEL.environment,
            enableSorting: false,
            size: 160,
            cell: ({ row }) => {
              if (row.original.type === "external") {
                return <span className="text-muted-foreground">—</span>;
              }
              const label =
                resolveCatalogEnvironmentLabel({
                  environmentId: row.original.value.environmentId ?? null,
                  environments,
                  defaultEnvironmentName: defaultEnvironment.name,
                }) ?? defaultEnvironment.name;
              return (
                // A plain badge with nothing to activate: the click may reach
                // the row and open the agent, like the rest of the cell.
                <Badge variant="outline" className="text-muted-foreground">
                  <span className="max-w-32 truncate">{label}</span>
                </Badge>
              );
            },
          } satisfies ColumnDef<AgentListRow>,
        ]
      : []),
    {
      id: "actions",
      header: "Actions",
      enableHiding: false,
      size: 220,
      cell: ({ row }) => (
        // The whole cell, so a disabled action's tooltip wrapper cannot let
        // the click through to the row either.
        <RowClickShield>
          {row.original.type === "external"
            ? renderExternalAgentActions(row.original.value)
            : renderAgentActions(row.original.value)}
        </RowClickShield>
      ),
    },
  ];

  const pinnedColumns: ColumnDef<AgentListRow>[] = columns.map((column) =>
    column.id === "name"
      ? { ...column, header: "Name", enableSorting: false }
      : column,
  );

  const renderAgentSection = ({
    title,
    sectionRows,
    sectionPagination,
    forceTable = false,
    sortable = true,
  }: {
    title?: string;
    sectionRows: AgentListRow[];
    sectionPagination?: { pageIndex: number; pageSize: number; total: number };
    forceTable?: boolean;
    sortable?: boolean;
  }) => (
    <section className="space-y-3">
      {title ? (
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
      ) : null}
      <TableCardViewContent
        forceTable={forceTable}
        cards={
          <TableCardList
            itemCount={sectionRows.length}
            isLoading={showLoading}
            emptyIcon={Bot}
            emptyMessage="No agents found"
            hasActiveFilters={hasActiveFilters}
            filteredEmptyMessage="No agents match your filters"
            onClearFilters={clearFilters}
            pagination={sectionPagination}
            onPaginationChange={
              sectionPagination ? handlePaginationChange : undefined
            }
          >
            {sectionRows.map(renderAgentCard)}
          </TableCardList>
        }
        table={
          <DataTable
            columns={sortable ? columns : pinnedColumns}
            tableClassName="table-fixed"
            fixedWidthColumnIds={["team", "provider", "environment"]}
            flexibleColumnIds={["name"]}
            data={sectionRows}
            isLoading={showLoading}
            getRowId={getAgentListRowId}
            rowSelection={effectiveRowSelection}
            onRowSelectionChange={onRowSelectionChange}
            rangeSelection={rangeSelection}
            hideSelectedCount
            sorting={sortable ? sorting : []}
            onSortingChange={sortable ? handleSortingChange : undefined}
            manualSorting
            manualPagination
            pagination={sectionPagination}
            onPaginationChange={
              sectionPagination ? handlePaginationChange : undefined
            }
            onRowClick={
              isDeletedView
                ? undefined
                : (row, event) =>
                    openRowOnPlainClick(event, () => {
                      if (row.type === "external") {
                        openExternalAgent(row.value);
                      } else {
                        router.push(agentDetailHref("agent", row.value.id));
                      }
                    })
            }
            emptyIcon={Bot}
            emptyMessage="No agents found"
            hasActiveFilters={hasActiveFilters}
            filteredEmptyMessage={
              isDeletedView
                ? "No deleted agents found."
                : "No agents match your filters"
            }
            onClearFilters={clearFilters}
          />
        }
      />
    </section>
  );

  return (
    <PageLayout
      title="Agents"
      description={
        <p className="text-sm text-muted-foreground">
          Build and manage AI agents, and connect external A2A agents for them
          to use as subagents.
        </p>
      }
      actionButton={
        <div className="flex gap-2">
          <PermissionButton
            variant="outline"
            permissions={{ agent: ["create"] }}
            onClick={() => setIsImportDialogOpen(true)}
          >
            <Upload className="h-4 w-4" />
            Import Agent
          </PermissionButton>
          {(canCreateAgent || canManageExternalAgents) && (
            <Button
              onClick={() => router.push(agentNewHref("agent"))}
              data-testid={E2eTestId.CreateAgentButton}
            >
              <Plus className="h-4 w-4" />
              Add Agent
            </Button>
          )}
        </div>
      }
    >
      {isAgentsLoadError || (!isDeletedView && isPinnedAgentsLoadError) ? (
        <QueryLoadError
          title="Couldn't load your agents"
          onRetry={() => {
            void refetchAgents();
            if (!isDeletedView) void refetchPinnedAgents();
          }}
        />
      ) : (
        <TableCardView storageKey="archestra-agents-view">
          <div>
            <div>
              <CollectionFilters>
                <FilterBar
                  leading
                  onClearFilters={hasActiveFilters ? clearFilters : undefined}
                  actions={!isDeletedView ? <TableCardViewToggle /> : undefined}
                  search={
                    <SearchInput
                      isLoading={isFetching || isPinnedFetching}
                      objectNamePlural="agents"
                      searchFields={["name"]}
                      paramName="name"
                      className={filterSearchClass}
                      queryParamsAdapter={queryParamsAdapter}
                    />
                  }
                >
                  <ResourceScopeFilter
                    showBuiltIn
                    showLabels
                    ownerLabelPlural="agents"
                    adminPermission={{ agent: ["admin"] }}
                    queryParamsAdapter={queryParamsAdapter}
                  />
                  <ProviderKeyFilterSelect
                    allowOrganizationDefault
                    value={providerApiKeyIdFilter}
                    onValueChange={(providerApiKeyId) =>
                      updateQueryParams({ page: "1", providerApiKeyId })
                    }
                  />
                  <ResourceDeletedStatusFilter
                    deletePermission={{ agent: ["delete"] }}
                    queryParamsAdapter={queryParamsAdapter}
                  />
                </FilterBar>
                {!canReadTeams && (
                  <PermissionRequirementHint
                    message="Team-based filters and sharing details are unavailable without"
                    permissions={[{ resource: "team", action: "read" }]}
                  />
                )}
                <ActiveFilterBadges
                  adminPermission={{ agent: ["admin"] }}
                  queryParamsAdapter={queryParamsAdapter}
                />
              </CollectionFilters>

              <BulkActions
                count={selectedCount}
                noun="agent"
                onClear={clearSelection}
                busy={bulkBusy}
                selectAllMatching={{
                  total: allMatchingSelected
                    ? selectedCount
                    : totalSelectableCount,
                  pageFullySelected:
                    selectablePageCount > 0 &&
                    pageSelection.length === selectablePageCount,
                  active: allMatchingSelected,
                  onSelectAll: () => setEscalatedFor(filterSignature),
                  matchDescription: nameFilter
                    ? "match this search query"
                    : "match the current filters",
                }}
              >
                <PermissionButton
                  permissions={bulkVisibilityPermissions}
                  disabled={allMatchingSelectionUnavailable}
                  variant="outline"
                  size="sm"
                  onClick={openBulkVisibility}
                >
                  <Pencil className="h-4 w-4" />
                  <span>Edit visibility</span>
                </PermissionButton>
                <PermissionButton
                  permissions={bulkDeletePermissions}
                  disabled={allMatchingSelectionUnavailable}
                  variant="destructive"
                  size="sm"
                  onClick={openBulkDelete}
                >
                  <Trash2 className="h-4 w-4" />
                  <span>Delete</span>
                </PermissionButton>
              </BulkActions>

              <div data-testid={E2eTestId.AgentsTable} className="space-y-6">
                {!isDeletedView && pinnedRows.length > 0
                  ? renderAgentSection({
                      title: "Pinned",
                      sectionRows: pinnedRows,
                      sortable: false,
                    })
                  : null}
                {isDeletedView
                  ? renderAgentSection({
                      sectionRows: unpinnedRows,
                      sectionPagination: {
                        pageIndex,
                        pageSize,
                        total: pagination.total,
                      },
                      forceTable: true,
                    })
                  : unpinnedRows.length > 0 || pinnedRows.length === 0
                    ? renderAgentSection({
                        title: "Agents",
                        sectionRows: unpinnedRows,
                        sectionPagination: {
                          pageIndex,
                          pageSize,
                          total: pagination.total,
                        },
                      })
                    : null}
              </div>

              {bulkVisibilityOpen && (
                <BulkVisibilityDialog
                  items={[
                    ...bulkVisibilityRegularAgents.map((profile) => ({
                      ...profile,
                      teams: profile.teams ?? [],
                      users: profile.users ?? [],
                    })),
                    ...bulkVisibilityExternalAgents,
                  ]}
                  noun="agent"
                  plural="agents"
                  open={bulkVisibilityOpen}
                  onOpenChange={(open) => {
                    setBulkVisibilityOpen(open);
                    if (!open) {
                      setBulkVisibilityRows([]);
                      setBulkVisibilityContext(null);
                    }
                  }}
                  isPending={
                    bulkAgentVisibility.isPending ||
                    bulkExternalAgentVisibility.isPending
                  }
                  applyDisabled={allMatchingSelectionUnavailable}
                  renderSelector={
                    bulkVisibilityExternalAgents.length > 0
                      ? ({ subject: _, ...props }) => (
                          <A2aRemoteAgentScopeSelector {...props} />
                        )
                      : undefined
                  }
                  onApply={async (change) => {
                    if (allMatchingSelectionUnavailable) return false;
                    const outcomes: BulkOutcome[] = [];
                    if (bulkVisibilityRegularAgents.length > 0) {
                      outcomes.push(
                        await bulkAgentVisibility.mutateAsync({
                          profiles: bulkVisibilityRegularAgents,
                          scope: change.scope,
                          teamIds: change.teamIds,
                          userIds: change.userIds,
                        }),
                      );
                    }
                    if (bulkVisibilityExternalAgents.length > 0) {
                      outcomes.push(
                        await bulkExternalAgentVisibility.mutateAsync({
                          agents: bulkVisibilityExternalAgents,
                          scope: change.scope,
                          teamIds: change.teamIds,
                          userIds: change.userIds,
                        }),
                      );
                    }
                    const outcome = combineBulkOutcomes(outcomes);
                    reportBulkOutcome({
                      outcome,
                      verb: "Updated",
                      failureVerb: "update",
                      noun: "agent",
                      plural: "agents",
                    });
                    if (outcome.succeeded.length === 0) return false;
                    if (outcome.failed.length === 0) clearSelection();
                    return true;
                  }}
                />
              )}

              {bulkDeleteOpen && (
                <DeleteConfirmDialog
                  open={bulkDeleteOpen}
                  onOpenChange={setBulkDeleteOpen}
                  title="Delete agents"
                  description={bulkDeleteDescription}
                  isPending={
                    bulkDeleteAgents.isPending ||
                    bulkDeleteExternalAgents.isPending
                  }
                  confirmDisabled={allMatchingSelectionUnavailable}
                  onConfirm={async () => {
                    if (allMatchingSelectionUnavailable) return;
                    const outcomes: BulkOutcome[] = [];
                    if (selectedRegularAgents.length > 0) {
                      outcomes.push(
                        await bulkDeleteAgents.mutateAsync(
                          selectedRegularAgents,
                        ),
                      );
                    }
                    if (selectedExternalAgents.length > 0) {
                      outcomes.push(
                        await runBulkAction({
                          items: selectedExternalAgents,
                          describe: (agent) => agent.name,
                          run: (agent) =>
                            bulkDeleteExternalAgents.mutateAsync(agent.id),
                        }),
                      );
                    }
                    const outcome = combineBulkOutcomes(outcomes);
                    reportBulkOutcome({
                      outcome,
                      verb: "Deleted",
                      failureVerb: "delete",
                      noun: "agent",
                    });
                    setBulkDeleteOpen(false);
                    // Rows that failed stay ticked so the selection can be
                    // retried rather than rebuilt.
                    if (outcome.failed.length === 0) clearSelection();
                  }}
                  confirmLabel="Delete agents"
                  pendingLabel="Deleting..."
                />
              )}

              {deletingAgentId && (
                <DeleteAgentDialog
                  agentId={deletingAgentId}
                  open={!!deletingAgentId}
                  onOpenChange={(open) => !open && setDeletingAgentId(null)}
                />
              )}

              <DeleteConfirmDialog
                open={deletingExternalAgent !== null}
                onOpenChange={(open) => !open && setDeletingExternalAgent(null)}
                title="Remove external A2A agent?"
                description={
                  deletingExternalAgent
                    ? getA2aRemoteAgentDeleteDescription(deletingExternalAgent)
                    : ""
                }
                isPending={deleteExternalAgent.isPending}
                onConfirm={() => {
                  if (!deletingExternalAgent) return;
                  deleteExternalAgent.mutate(deletingExternalAgent.id, {
                    onSuccess: () => setDeletingExternalAgent(null),
                  });
                }}
              />

              {permanentlyDeletingAgent && (
                <DeleteConfirmDialog
                  open={!!permanentlyDeletingAgent}
                  onOpenChange={(open) =>
                    !open && setPermanentlyDeletingAgent(null)
                  }
                  title="Delete agent permanently"
                  description={AGENT_PAGE_CONFIGS.agent.permanentDeleteDescription(
                    permanentlyDeletingAgent.name,
                  )}
                  isPending={permanentlyDeleteAgent.isPending}
                  onConfirm={() => {
                    permanentlyDeleteAgent.mutate(permanentlyDeletingAgent.id, {
                      onSuccess: (ok) => {
                        if (ok) setPermanentlyDeletingAgent(null);
                      },
                    });
                  }}
                  confirmLabel={PERMANENT_DELETE_LABEL}
                />
              )}

              <ImportAgentDialog
                open={isImportDialogOpen}
                onOpenChange={setIsImportDialogOpen}
                onSuccess={() => {}}
              />

              <ConvertToSkillDialog
                agent={convertingAgent}
                onOpenChange={(open) => {
                  if (!open) setConvertingAgent(null);
                }}
              />

              <CloneAgentDialog
                agent={cloningAgent}
                onOpenChange={(open) => {
                  if (!open) setCloningAgent(null);
                }}
                onCloned={(cloned) => {
                  // Land on the clone's Configuration step so it can be renamed
                  // straight away.
                  router.push(
                    agentConfigureHref("agent", cloned.id, "configuration"),
                  );
                }}
              />

              <AgentVersionHistoryDialog
                agentId={history?.id ?? null}
                canModify={!!history?.canModify}
                onOpenChange={(open) => {
                  if (!open) setHistory(null);
                }}
              />
            </div>
          </div>
        </TableCardView>
      )}
    </PageLayout>
  );
}

function DeleteAgentDialog({
  agentId,
  open,
  onOpenChange,
}: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteAgent = useDeleteProfile();

  // `mutate` with callbacks rather than an awaited `mutateAsync`: the query
  // layer rejects on failure (and toasts), and an unhandled rejection here
  // would take the page down instead.
  const handleDelete = useCallback(() => {
    deleteAgent.mutate(agentId, {
      onSuccess: (result) => {
        if (!result) return;
        toast.success("Agent deleted successfully");
        onOpenChange(false);
      },
    });
  }, [agentId, deleteAgent, onOpenChange]);

  return (
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete Agent"
      description="Are you sure you want to delete this agent? This action cannot be undone."
      isPending={deleteAgent.isPending}
      onConfirm={handleDelete}
      confirmLabel="Delete Agent"
      pendingLabel="Deleting..."
    />
  );
}
