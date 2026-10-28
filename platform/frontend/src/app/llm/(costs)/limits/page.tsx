"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ArrowRightLeft,
  Bot,
  Boxes,
  Building2,
  CircleDollarSign,
  Coins,
  Edit,
  Info,
  Key,
  KeyRound,
  type LucideIcon,
  MessageSquareText,
  Plus,
  Trash2,
  User,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSetCostsAction } from "@/app/llm/(costs)/layout";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import { AgentIcon } from "@/components/agent-icon";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import { AgentSelector } from "@/components/agent-selector";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EntityLabelFilter } from "@/components/entity-label-filter";
import { EnvironmentSelector } from "@/components/environment-selector";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterControlClass,
} from "@/components/filter-bar";
import { FormDialog } from "@/components/form-dialog";
import { useSelectedLabels } from "@/components/label-select";
import { LabelTags } from "@/components/label-tags";
import {
  type LimitCleanupInterval as BudgetCleanupInterval,
  CLEANUP_INTERVAL_LABELS,
  DEFAULT_LIMIT_CLEANUP_INTERVAL,
  LimitCleanupIntervalSelect,
} from "@/components/limit-cleanup-interval-select";
import { LlmModelPicker } from "@/components/llm-model-picker";
import { QueryLoadError } from "@/components/query-load-error";
import { RemoteUserSelect } from "@/components/remote-user-select";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { BulkActionsScope } from "@/components/ui/bulk-actions-context";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { FieldDescription } from "@/components/ui/field-description";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { SearchableSelect } from "@/components/ui/searchable-select";
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
import { VirtualKeySearchableSelect } from "@/components/virtual-key-searchable-select";
import { useAgentOptionsByIds } from "@/lib/agent-options.query";
import { reportBulkOutcome } from "@/lib/bulk-action";
import { useDefaultUserLimits } from "@/lib/default-user-limit.query";
import {
  useLimitLabelKeys,
  useLimitLabelValues,
} from "@/lib/entity-labels.query";
import { useEnvironments } from "@/lib/environment.query";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import {
  useBulkDeleteLimits,
  useCreateLimit,
  useDeleteLimit,
  useLimits,
  useUpdateLimit,
} from "@/lib/limits.query";
import { useLlmModelOptions } from "@/lib/llm-models.query";
import { useLlmOauthClients } from "@/lib/llm-oauth-clients.query";
import { useMemberOptionsReferences } from "@/lib/member-options.query";
import { useOrganization } from "@/lib/organization.query";
import { logoNameForProvider } from "@/lib/provider-logos";
import { useTeams } from "@/lib/teams/team.query";
import { cn } from "@/lib/utils/tailwind";
import { useAllVirtualApiKeys } from "@/lib/virtual-api-keys.query";

type LimitData = archestraApiTypes.GetLimitsResponses["200"][number];
type LimitCleanupInterval = BudgetCleanupInterval | "minute";
type LimitEntityType = archestraApiTypes.CreateLimitData["body"]["entityType"];
type UsageStatus = "safe" | "warning" | "danger";
type UsageSummary = {
  percentage: number;
  status: UsageStatus;
  actualUsage: number;
  actualLimit: number;
};

const canBulkDeleteLimit = (limit: LimitData) => limit.entityType !== "user";

type LimitFormState = {
  limitType: "token_cost" | "requests" | "tokens";
  entityType: LimitEntityType;
  entityId: string;
  limitValue: string;
  cleanupInterval: LimitCleanupInterval;
  hasExplicitInterval: boolean;
  models: string[];
  isAllModels: boolean;
  labels: ProfileLabel[];
};

const DEFAULT_FORM_STATE: LimitFormState = {
  limitType: "token_cost",
  entityType: "organization",
  entityId: "",
  limitValue: "",
  cleanupInterval: DEFAULT_LIMIT_CLEANUP_INTERVAL,
  hasExplicitInterval: false,
  models: [],
  isAllModels: true,
  labels: [],
};

const LIMITS_ENTITY_SELECTOR_PAGE_SIZE = 100;
const MAX_VISIBLE_MODEL_BADGES = 3;

const ENTITY_TYPE_ITEMS: Array<{
  value: LimitEntityType;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    value: "organization",
    label: "Organization",
    description: "A shared spend limit across your organization.",
    icon: <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />,
  },
  {
    value: "team",
    label: "Team",
    description:
      "Caps the combined spend of every agent and LLM proxy in a team.",
    icon: <Users className="h-4 w-4 shrink-0 text-muted-foreground" />,
  },
  {
    value: "agent",
    label: "Agent",
    description: "Caps spend for a single agent.",
    icon: (
      <AgentIcon
        icon={null}
        fallbackType="agent"
        className="h-4 w-4 shrink-0 text-muted-foreground"
      />
    ),
  },
  {
    value: "user",
    label: "User",
    description: "Caps one user's spend across the whole organization.",
    icon: <User className="h-4 w-4 shrink-0 text-muted-foreground" />,
  },
  {
    value: "virtual_key",
    label: "Virtual Key",
    description:
      "Caps spend for requests made with a specific virtual API key.",
    icon: <Key className="h-4 w-4 shrink-0 text-muted-foreground" />,
  },
  {
    value: "llm_oauth_client",
    label: "LLM OAuth Client",
    description:
      "Caps spend for requests made by an application through an LLM OAuth client.",
    icon: <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />,
  },
  {
    value: "environment",
    label: "Environment",
    description:
      "Caps the combined spend of all users in a deployment environment (e.g. production).",
    icon: <Boxes className="h-4 w-4 shrink-0 text-muted-foreground" />,
  },
];

function formatCurrency(value: number, fractionDigits = 0) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

function getLimitValuePlaceholder(
  unit: LimitFormState["limitType"],
  interval: LimitCleanupInterval,
) {
  const examples: Record<
    LimitCleanupInterval,
    [spend: number, requests: number, tokens: number]
  > = {
    minute: [1, 60, 100_000],
    "1h": [10, 1_000, 1_000_000],
    "12h": [50, 5_000, 5_000_000],
    "24h": [100, 10_000, 10_000_000],
    calendar_day: [100, 10_000, 10_000_000],
    "1w": [500, 50_000, 50_000_000],
    calendar_week_sunday: [500, 50_000, 50_000_000],
    calendar_week_monday: [500, 50_000, 50_000_000],
    "1m": [2_000, 200_000, 200_000_000],
    calendar_month: [2_000, 200_000, 200_000_000],
  };
  const [spend, requests, tokens] = examples[interval];
  const amount =
    unit === "token_cost" ? spend : unit === "requests" ? requests : tokens;
  return `e.g. ${amount.toLocaleString("en-US")}`;
}

import {
  type LimitFilterModel,
  LimitModelFilter,
} from "./_parts/limit-model-filter";
import { UserLimitsOverview } from "./_parts/user-limits-overview";

export default function LimitsPage() {
  const setActionButton = useSetCostsAction();
  const {
    data: limits = [],
    isPending,
    isFetching,
    isLoadingError: isLimitsLoadError,
    refetch: refetchLimits,
  } = useLimits();
  const { data: teams = [] } = useTeams({ includeRelations: false });
  const { data: organization } = useOrganization();
  const { data: members = EMPTY_ENTITY_OPTIONS } = useMemberOptionsReferences({
    ids: limits
      .filter((limit) => limit.entityType === "user")
      .map((limit) => limit.entityId),
  });
  const { data: defaultUserLimits = [] } = useDefaultUserLimits();
  const { data: virtualKeysData } = useAllVirtualApiKeys({
    limit: LIMITS_ENTITY_SELECTOR_PAGE_SIZE,
  });
  const virtualKeys = virtualKeysData?.data ?? [];
  const { data: oauthClientsData } = useLlmOauthClients({
    limit: LIMITS_ENTITY_SELECTOR_PAGE_SIZE,
  });
  const oauthClients = oauthClientsData?.data ?? [];
  const { data: agents = EMPTY_ENTITY_OPTIONS } = useAgentOptionsByIds({
    ids: limits
      .filter((limit) => limit.entityType === "agent")
      .map((limit) => limit.entityId),
    filters: { agentType: "agent" },
  });
  const { data: environmentsData } = useEnvironments();
  const environments = environmentsData?.environments ?? [];
  const { data: modelsWithApiKeys = [] } = useLlmModelOptions();
  const createLimit = useCreateLimit();
  const updateLimit = useUpdateLimit();
  const deleteLimit = useDeleteLimit();
  const bulkDeleteLimits = useBulkDeleteLimits();

  const {
    searchParams,
    updateQueryParams,
    pageIndex,
    pageSize,
    setPagination,
  } = useDataTableQueryParams({ defaultPageSize: 10 });
  const unitsParam = searchParams.get("units");
  const unitsFilter =
    unitsParam === "token_cost" ||
    unitsParam === "requests" ||
    unitsParam === "tokens"
      ? unitsParam
      : "all";
  const statusFilter = searchParams.get("status") || "all";
  const appliedToFilter = searchParams.get("appliedTo") || "all";
  const entityIdParam = searchParams.get("entityId");
  const entityIdFilter =
    appliedToFilter !== "all" &&
    entityIdParam &&
    /^[\w-]{1,128}$/.test(entityIdParam)
      ? entityIdParam
      : null;
  const modelFilter = searchParams.get("model") || "all";
  const labelsFilter = searchParams.get("labels") || "";
  const selectedLabels = useSelectedLabels();
  const [limitToDelete, setLimitToDelete] = useState<LimitData | null>(null);
  const [isBulkDeleteDialogOpen, setIsBulkDeleteDialogOpen] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [formState, setFormState] =
    useState<LimitFormState>(DEFAULT_FORM_STATE);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const limitValueRef = useRef<HTMLInputElement>(null);

  const editId = searchParams.get("edit");
  // The list is unfiltered and unpaginated, so every limit the `edit` param can
  // name is already in it.
  const limitFromUrl = limits.find((limit) => limit.id === editId) ?? null;
  const {
    entity: editingLimit,
    open: openEditDialog,
    close: closeEditDialog,
  } = useDialogUrlParam<LimitData>({
    paramName: "edit",
    entityFromUrl: limitFromUrl,
  });

  const llmLimits = useMemo(
    () =>
      limits.filter((limit) =>
        [
          "token_cost",
          "requests",
          "tokens",
          "requests_per_minute",
          "tokens_per_minute",
        ].includes(limit.limitType),
      ),
    [limits],
  );

  const modelOptions = useMemo(
    () =>
      modelsWithApiKeys.map((model) => ({
        value: model.modelId,
        model: model.modelId,
        provider: model.provider,
        pricePerMillionInput: model.pricePerMillionInput ?? "0",
        pricePerMillionOutput: model.pricePerMillionOutput ?? "0",
      })),
    [modelsWithApiKeys],
  );
  const filterModels = useMemo(
    () =>
      modelsWithApiKeys.map((model) => ({
        modelId: model.modelId,
        provider: model.provider,
        // The same display name the chat model picker shows.
        displayName: model.description || model.modelId,
        isBest: model.isBest,
      })),
    [modelsWithApiKeys],
  );
  const modelByModelId = useMemo(
    () => new Map(filterModels.map((model) => [model.modelId, model])),
    [filterModels],
  );
  const limitCountByModel = useMemo(() => {
    // The filter keeps all-models limits for every model, so count them too.
    const allModelsCount = llmLimits.filter(
      (limit) => getLimitModels(limit).length === 0,
    ).length;
    const counts = new Map<string, number>(
      filterModels.map((model) => [model.modelId, allModelsCount]),
    );
    for (const limit of llmLimits) {
      for (const model of getLimitModels(limit)) {
        counts.set(model, (counts.get(model) ?? allModelsCount) + 1);
      }
    }
    return counts;
  }, [llmLimits, filterModels]);

  const handleCreateOpen = useCallback(() => {
    closeEditDialog();
    setFormState({ ...DEFAULT_FORM_STATE, labels: [] });
    setIsCreateDialogOpen(true);
  }, [closeEditDialog]);

  useEffect(() => {
    setActionButton(
      <PermissionButton
        permissions={{ llmLimit: ["create"] }}
        size="sm"
        onClick={handleCreateOpen}
      >
        <Plus className="h-4 w-4" />
        Add Limit
      </PermissionButton>,
    );

    return () => setActionButton(null);
  }, [handleCreateOpen, setActionButton]);

  const buildEditFormState = useCallback((limit: LimitData): LimitFormState => {
    const models = getLimitModels(limit);
    const isAllModels = models.length === 0;

    return {
      limitType:
        limit.limitType === "requests_per_minute"
          ? "requests"
          : limit.limitType === "tokens_per_minute"
            ? "tokens"
            : (limit.limitType as LimitFormState["limitType"]),
      entityType: limit.entityType,
      entityId: limit.entityType === "organization" ? "" : limit.entityId,
      limitValue: String(limit.limitValue),
      cleanupInterval: getLimitInterval(limit),
      hasExplicitInterval: true,
      models: isAllModels ? [] : models,
      isAllModels,
      // A limit read before labels existed carries none; the labels field
      // shows open now, so it needs a list.
      labels: limit.labels ?? [],
    };
  }, []);

  // Seed the edit form exactly once per opened limit — row clicks and deep
  // links share this path. Refetching must not wipe in-progress edits.
  const seededEditIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!editingLimit) {
      seededEditIdRef.current = null;
      return;
    }
    if (seededEditIdRef.current === editingLimit.id) {
      return;
    }
    seededEditIdRef.current = editingLimit.id;
    setFormState(buildEditFormState(editingLimit));
  }, [editingLimit, buildEditFormState]);

  const getEntityLabel = useCallback(
    (limit: Pick<LimitData, "entityType" | "entityId">) => {
      if (limit.entityType === "organization") {
        return "Organization";
      }
      if (limit.entityType === "team") {
        const team = teams.find((candidate) => candidate.id === limit.entityId);
        return team?.name ?? "Unknown team";
      }
      if (limit.entityType === "user") {
        const member = members.find(
          (candidate) => candidate.id === limit.entityId,
        );
        return member?.name ?? member?.email ?? "Unknown user";
      }
      if (limit.entityType === "virtual_key") {
        const key = virtualKeys.find(
          (candidate) => candidate.id === limit.entityId,
        );
        return key?.name ?? "Unknown key";
      }
      if (limit.entityType === "llm_oauth_client") {
        const client = oauthClients.find(
          (candidate) => candidate.id === limit.entityId,
        );
        return client?.name ?? "Unknown OAuth client";
      }
      if (limit.entityType === "agent") {
        const agent = agents.find(
          (candidate) => candidate.id === limit.entityId,
        );
        return agent?.name ?? "Unknown agent";
      }
      if (limit.entityType === "environment") {
        const environment = environments.find(
          (candidate) => candidate.id === limit.entityId,
        );
        return environment?.name ?? "Unknown environment";
      }
      return "Unknown";
    },
    [teams, members, virtualKeys, oauthClients, agents, environments],
  );

  const getEntityScopeLabel = useCallback((limit: LimitData) => {
    return ENTITY_SCOPE_LABELS[limit.entityType] ?? "Limit";
  }, []);

  const getEntityIcon = useCallback((limit: LimitData) => {
    const iconClassName = "h-4 w-4 shrink-0 text-muted-foreground";
    if (limit.entityType === "agent") {
      return (
        <AgentIcon icon={null} fallbackType="agent" className={iconClassName} />
      );
    }
    const Icon = {
      organization: Building2,
      team: Users,
      user: User,
      virtual_key: Key,
      llm_oauth_client: KeyRound,
      environment: Boxes,
    }[limit.entityType];
    return <Icon className={iconClassName} />;
  }, []);

  const getUsageStatus = useCallback((limit: LimitData): UsageSummary => {
    const actualUsage =
      limit.throughputUsage?.currentUsage ??
      (limit.modelUsage ?? []).reduce((sum, usage) => sum + usage.cost, 0);
    const actualLimit = limit.limitValue;
    const percentage = actualLimit > 0 ? (actualUsage / actualLimit) * 100 : 0;
    if (percentage >= 90) {
      return { percentage, status: "danger", actualUsage, actualLimit };
    }
    if (percentage >= 75) {
      return { percentage, status: "warning", actualUsage, actualLimit };
    }
    return { percentage, status: "safe", actualUsage, actualLimit };
  }, []);

  const filteredLimits = useMemo(() => {
    return llmLimits.filter((limit) => {
      const usageStatus = getUsageStatus(limit).status;
      const matchesStatus =
        statusFilter === "all" || usageStatus === statusFilter;
      const matchesUnits =
        unitsFilter === "all" ||
        limit.limitType === unitsFilter ||
        (unitsFilter === "requests" &&
          limit.limitType === "requests_per_minute") ||
        (unitsFilter === "tokens" && limit.limitType === "tokens_per_minute");
      const matchesAppliedTo =
        appliedToFilter === "all" || limit.entityType === appliedToFilter;
      const matchesEntity =
        !entityIdFilter || limit.entityId === entityIdFilter;
      const isAllModelsLimit =
        !limit.model ||
        (Array.isArray(limit.model) && limit.model.length === 0);
      const matchesModel =
        modelFilter === "all" ||
        (Array.isArray(limit.model) && limit.model.includes(modelFilter)) ||
        isAllModelsLimit;

      // Applied here rather than on the query: this page reads every visible
      // limit once and narrows it in the browser, as its other filters do.
      const matchesLabels =
        !selectedLabels ||
        Object.entries(selectedLabels).every(([key, values]) =>
          limit.labels.some(
            (label) => label.key === key && values.includes(label.value),
          ),
        );

      return (
        matchesUnits &&
        matchesStatus &&
        matchesAppliedTo &&
        matchesEntity &&
        matchesModel &&
        matchesLabels
      );
    });
  }, [
    appliedToFilter,
    entityIdFilter,
    llmLimits,
    modelFilter,
    statusFilter,
    unitsFilter,
    getUsageStatus,
    selectedLabels,
  ]);

  const {
    rowSelection,
    setRowSelection,
    onPageRowIdsChange,
    clearSelection,
    selected: selectedLimits,
    selectAllMatching,
  } = useBulkSelection({
    rows: filteredLimits,
    getId: (limit) => limit.id,
    canSelect: canBulkDeleteLimit,
    filterSignature: JSON.stringify({
      statusFilter,
      unitsFilter,
      appliedToFilter,
      entityIdFilter,
      modelFilter,
      labelsFilter,
    }),
    matchDescription: "match the current filters",
  });

  const columns = useMemo<ColumnDef<LimitData>[]>(
    () => [
      createSelectColumn<LimitData>({
        rowLabel: (limit) =>
          `Select ${getEntityLabel(limit)} ${limitMetricLabel(limit)} rule`,
        allLabel: "Select all limits on this page",
        canSelect: canBulkDeleteLimit,
        disabledReason: () =>
          "User limits must be deleted individually because they can span organizations",
      }),
      {
        id: "entityId",
        header: "Applied to",
        size: 220,
        minSize: 160,
        cell: ({ row }) => {
          const limit = row.original;
          return (
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex size-6 shrink-0 items-center justify-center rounded bg-muted">
                {getEntityIcon(limit)}
              </span>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{getEntityLabel(limit)}</span>
                  <LabelTags labels={limit.labels} />
                </div>
                {limit.entityType !== "organization" && (
                  <div className="truncate text-xs text-muted-foreground">
                    {getEntityScopeLabel(limit)}
                  </div>
                )}
                {limit.reason ? (
                  <div
                    title={limit.reason}
                    className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
                  >
                    <MessageSquareText
                      aria-hidden
                      className="size-3 shrink-0"
                    />
                    <span className="sr-only">Reason: </span>
                    <span className="truncate">{limit.reason}</span>
                  </div>
                ) : null}
              </div>
            </div>
          );
        },
      },
      {
        id: "model",
        header: "Models",
        size: 170,
        minSize: 160,
        cell: ({ row }) => (
          <LimitModels
            models={getLimitModels(row.original)}
            modelByModelId={modelByModelId}
          />
        ),
      },
      {
        id: "kind",
        header: "Kind",
        size: 120,
        minSize: 110,
        cell: ({ row }) => (
          <LimitKindLabel limitType={row.original.limitType} />
        ),
      },
      {
        id: "usage",
        header: "Usage",
        size: 320,
        minSize: 240,
        cell: ({ row }) => (
          <LimitUsage
            limit={row.original}
            usage={getUsageStatus(row.original)}
          />
        ),
      },
      {
        id: "actions",
        header: "Actions",
        size: 100,
        minSize: 80,
        cell: ({ row }) => (
          <TableRowActions
            size="sm"
            itemName={`${getEntityLabel(row.original)} ${limitMetricLabel(row.original)}`}
            actions={[
              {
                icon: <Edit className="h-4 w-4" />,
                label: "Edit limit",
                permissions: { llmLimit: ["update"] },
                onClick: () => openEditDialog(row.original),
              },
              {
                icon: <Trash2 className="h-4 w-4" />,
                label: "Delete limit",
                variant: "destructive",
                permissions: { llmLimit: ["delete"] },
                onClick: () => setLimitToDelete(row.original),
              },
            ]}
          />
        ),
      },
    ],
    [
      getEntityIcon,
      getEntityLabel,
      getEntityScopeLabel,
      getUsageStatus,
      modelByModelId,
      openEditDialog,
    ],
  );

  const statusCounts = useMemo(() => {
    const counts: Record<UsageStatus, number> = {
      safe: 0,
      warning: 0,
      danger: 0,
    };
    for (const limit of llmLimits) counts[getUsageStatus(limit).status] += 1;
    return counts;
  }, [llmLimits, getUsageStatus]);
  const appliedToCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const limit of llmLimits) {
      const key = limit.entityType;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [llmLimits]);

  const hasActiveFilters =
    statusFilter !== "all" ||
    unitsFilter !== "all" ||
    appliedToFilter !== "all" ||
    Boolean(entityIdFilter) ||
    modelFilter !== "all" ||
    Boolean(labelsFilter);
  const clearFilters = useCallback(
    () =>
      updateQueryParams({
        status: null,
        units: null,
        appliedTo: null,
        entityId: null,
        model: null,
        labels: null,
        page: null,
      }),
    [updateQueryParams],
  );
  const shouldShowDefaultUserLimitNotice =
    formState.entityType === "user" && defaultUserLimits.length > 0;

  function closeDialog() {
    if (editingLimit) {
      closeEditDialog();
    } else {
      setIsCreateDialogOpen(false);
    }
  }

  async function handleSubmit() {
    if (!canSubmit || createLimit.isPending || updateLimit.isPending) return;
    const finalLabels =
      labelsRef.current?.saveUnsavedLabel() ?? formState.labels;
    const body = {
      entityType: formState.entityType,
      entityId:
        formState.entityType === "organization"
          ? (organization?.id ?? "")
          : formState.entityId,
      limitType: formState.limitType,
      limitValue: Number(formState.limitValue),
      cleanupInterval: formState.cleanupInterval,
      model: formState.isAllModels ? null : formState.models,
      labels: finalLabels,
    };

    if (editingLimit) {
      const result = await updateLimit.mutateAsync({
        id: editingLimit.id,
        ...body,
      });
      if (result) {
        closeEditDialog();
      }
      return;
    }

    const result = await createLimit.mutateAsync(body);
    if (result) {
      setIsCreateDialogOpen(false);
    }
  }

  async function handleDelete() {
    if (!limitToDelete) return;
    await deleteLimit.mutateAsync({ id: limitToDelete.id });
    setLimitToDelete(null);
  }

  const validAmount =
    /^\d+$/.test(formState.limitValue) &&
    Number.isSafeInteger(Number(formState.limitValue)) &&
    Number(formState.limitValue) > 0 &&
    Number(formState.limitValue) <= 2147483647;
  const canSubmit =
    validAmount &&
    ((formState.limitType === "token_cost" &&
      formState.cleanupInterval !== "minute") ||
      ["organization", "team", "virtual_key"].includes(formState.entityType)) &&
    (formState.isAllModels || formState.models.length > 0) &&
    (formState.entityType === "organization" || formState.entityId.length > 0);

  // Gate the page on the limits list itself. The entity selectors (teams,
  // members, virtual keys, agents, environments, models) degrade locally if
  // their own fetch fails, so a secondary failure doesn't blank the page.
  if (isLimitsLoadError) {
    return (
      <div className="space-y-4">
        <QueryLoadError
          title="Couldn't load usage limits"
          onRetry={() => refetchLimits()}
        />
      </div>
    );
  }

  return (
    <div className="-mt-3">
      <UserLimitsOverview
        limitsTable={
          <BulkActionsScope>
            <CollectionFilters>
              <FilterBar
                onClearFilters={hasActiveFilters ? clearFilters : undefined}
              >
                <FilterSelect
                  value={statusFilter}
                  onValueChange={(value) =>
                    updateQueryParams({
                      status: value === "all" ? null : value,
                      page: null,
                    })
                  }
                  placeholder="All statuses"
                  showSearch={false}
                  items={[
                    { value: "all", label: "All statuses" },
                    ...USAGE_STATUSES.map((status) => ({
                      value: status,
                      label: USAGE_STATUS_META[status].label,
                      content: (
                        <FilterOptionLabel
                          icon={<UsageStatusDot status={status} />}
                          label={USAGE_STATUS_META[status].label}
                          hint={USAGE_STATUS_META[status].hint}
                          count={statusCounts[status]}
                        />
                      ),
                      selectedContent: (
                        <span className="flex items-center gap-2">
                          <UsageStatusDot status={status} />
                          {USAGE_STATUS_META[status].label}
                        </span>
                      ),
                    })),
                  ]}
                />
                <FilterSelect
                  value={appliedToFilter}
                  onValueChange={(value) =>
                    updateQueryParams({
                      appliedTo: value === "all" ? null : value,
                      entityId: null,
                      page: null,
                    })
                  }
                  placeholder="All applied to"
                  showSearch={false}
                  items={[
                    { value: "all", label: "All applied to" },
                    ...APPLIED_TO_OPTIONS.map((option) => ({
                      value: option.value,
                      label: option.label,
                      content: (
                        <FilterOptionLabel
                          icon={
                            <option.icon className="size-4 text-muted-foreground" />
                          }
                          label={option.label}
                          count={appliedToCounts[option.value] ?? 0}
                        />
                      ),
                      selectedContent: (
                        <span className="flex items-center gap-2">
                          <option.icon className="size-4" />
                          {option.label}
                        </span>
                      ),
                    })),
                  ]}
                />
                {entityIdFilter && (
                  <FilterSelect
                    value={entityIdFilter}
                    onValueChange={(value) =>
                      updateQueryParams({
                        entityId: value === "all" ? null : value,
                        page: null,
                      })
                    }
                    placeholder="All entities"
                    ariaLabel="Filter by entity"
                    items={[
                      { value: "all", label: "All entities" },
                      ...Array.from(
                        new Map([
                          ...llmLimits
                            .filter(
                              (limit) => limit.entityType === appliedToFilter,
                            )
                            .map(
                              (limit) =>
                                [
                                  limit.entityId,
                                  getEntityLabel(limit),
                                ] as const,
                            ),
                          [
                            entityIdFilter,
                            getEntityLabel({
                              entityType:
                                appliedToFilter as LimitData["entityType"],
                              entityId: entityIdFilter,
                            }),
                          ] as const,
                        ]),
                        ([value, label]) => ({ value, label }),
                      ),
                    ]}
                  />
                )}
                <LimitModelFilter
                  value={modelFilter}
                  onValueChange={(value) =>
                    updateQueryParams({
                      model: value === "all" ? null : value,
                      page: null,
                    })
                  }
                  models={filterModels}
                  limitCountByModel={limitCountByModel}
                />
                <EntityLabelFilter
                  useLabelKeys={useLimitLabelKeys}
                  useLabelValues={useLimitLabelValues}
                  className={filterControlClass({
                    active: Boolean(selectedLabels),
                  })}
                />
                <FilterSelect
                  value={unitsFilter}
                  onValueChange={(value) =>
                    updateQueryParams({
                      units: value === "all" ? null : value,
                      page: null,
                    })
                  }
                  placeholder="All kinds"
                  ariaLabel="Filter by limit kind"
                  showSearch={false}
                  items={[
                    { value: "all", label: "All kinds" },
                    {
                      value: "token_cost",
                      label: "Spend",
                      content: <LimitKindLabel limitType="token_cost" />,
                      selectedContent: (
                        <LimitKindLabel limitType="token_cost" />
                      ),
                    },
                    {
                      value: "tokens",
                      label: "Tokens",
                      content: <LimitKindLabel limitType="tokens" />,
                      selectedContent: <LimitKindLabel limitType="tokens" />,
                    },
                    {
                      value: "requests",
                      label: "Requests",
                      content: <LimitKindLabel limitType="requests" />,
                      selectedContent: <LimitKindLabel limitType="requests" />,
                    },
                  ]}
                />
              </FilterBar>
            </CollectionFilters>

            {/* The table reports its own first load, rather than a centred loader
            standing in for it: swapping a full-height indicator out for the
            table put the toolbar, headers and pagination on screen a beat
            after the wait had already visibly ended, so one navigation read as
            loader, then chrome, then rows. The table keeps its shape from the
            first frame and fills in. */}
            <BulkActions
              count={selectedLimits.length}
              noun="limit"
              onClear={clearSelection}
              busy={bulkDeleteLimits.isPending}
              selectAllMatching={selectAllMatching}
            >
              <PermissionButton
                permissions={{ llmLimit: ["delete"] }}
                variant="destructive"
                size="sm"
                onClick={() => setIsBulkDeleteDialogOpen(true)}
              >
                <Trash2 className="h-4 w-4" />
                <span>Delete</span>
              </PermissionButton>
            </BulkActions>
            <DataTable
              columns={columns}
              data={filteredLimits}
              pagination={{
                pageIndex: Number.isFinite(pageIndex) ? pageIndex : 0,
                pageSize: Number.isFinite(pageSize) ? pageSize : 10,
                total: filteredLimits.length,
              }}
              onPaginationChange={setPagination}
              getRowId={(limit) => limit.id}
              rowSelection={rowSelection}
              onRowSelectionChange={setRowSelection}
              onPageRowIdsChange={onPageRowIdsChange}
              hideSelectedCount
              emptyIcon={CircleDollarSign}
              emptyMessage="No limits configured"
              hasActiveFilters={hasActiveFilters}
              filteredEmptyMessage="No limits match your filters"
              onClearFilters={clearFilters}
              isLoading={(isPending || isFetching) && limits.length === 0}
            />
          </BulkActionsScope>
        }
      />

      <FormDialog
        open={isCreateDialogOpen || !!editingLimit}
        onOpenChange={(open) => !open && closeDialog()}
        title={editingLimit ? "Edit limit" : "Create limit"}
        initialFocusRef={editingLimit ? limitValueRef : undefined}
        description={
          editingLimit
            ? "Adjust the amount, models or interval."
            : "Choose who this limit applies to and how much they can use."
        }
        size="medium"
      >
        <DialogForm
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
        >
          <DialogBody className="space-y-4">
            <InlineNotice variant="warning">
              <Info aria-hidden="true" />
              <InlineNoticeText>
                Requests are blocked when any applicable limit is reached. For
                example, a virtual key with remaining allowance is still blocked
                if its team or organization has reached a limit.
              </InlineNoticeText>
            </InlineNotice>

            {shouldShowDefaultUserLimitNotice && (
              <InlineNotice variant="info">
                <Info aria-hidden="true" />
                <InlineNoticeText>
                  This custom user spend limit will override the default user
                  spend limit for the selected user.
                </InlineNoticeText>
              </InlineNotice>
            )}

            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex h-5 items-center gap-1.5">
                  <Label>Apply to</Label>
                  {editingLimit && (
                    <LimitFieldHelp label="Apply to help">
                      Create a new limit to change who it applies to.
                    </LimitFieldHelp>
                  )}
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <SearchableSelect
                    value={formState.entityType}
                    onValueChange={(value) =>
                      setFormState((current) => ({
                        ...current,
                        entityType: value as LimitEntityType,
                        entityId: "",
                      }))
                    }
                    placeholder="Select scope"
                    ariaLabel="Limit scope"
                    disabled={Boolean(editingLimit)}
                    items={ENTITY_TYPE_ITEMS.filter(
                      (item) =>
                        item.value === formState.entityType ||
                        (formState.limitType === "token_cost" &&
                          formState.cleanupInterval !== "minute") ||
                        ["organization", "team", "virtual_key"].includes(
                          item.value,
                        ),
                    ).map((item) => ({
                      value: item.value,
                      label: item.label,
                      searchText: `${item.label} ${item.description}`,
                      content: (
                        <span className="flex flex-col gap-0.5">
                          <span className="flex items-center gap-2">
                            {item.icon}
                            {item.label}
                          </span>
                          <span className="pl-6 text-xs text-muted-foreground">
                            {formState.limitType === "token_cost"
                              ? item.description
                              : "Shared allowance across matching requests."}
                          </span>
                        </span>
                      ),
                      selectedContent: (
                        <span className="flex items-center gap-2">
                          {item.icon}
                          {item.label}
                        </span>
                      ),
                    }))}
                    className="w-full sm:flex-1"
                    showSearchIcon={false}
                  />

                  {formState.entityType === "team" && (
                    <SearchableSelect
                      value={formState.entityId}
                      onValueChange={(value) =>
                        setFormState((current) => ({
                          ...current,
                          entityId: value,
                        }))
                      }
                      placeholder="Select team"
                      items={teams.map((team) => ({
                        value: team.id,
                        label: team.name,
                        description: team.description ?? undefined,
                      }))}
                      className="w-full sm:flex-1"
                      disabled={Boolean(editingLimit)}
                    />
                  )}

                  {formState.entityType === "user" && (
                    <RemoteUserSelect
                      value={formState.entityId}
                      onValueChange={(value) =>
                        setFormState((current) => ({
                          ...current,
                          entityId: value,
                        }))
                      }
                      placeholder="Select user"
                      disabled={Boolean(editingLimit)}
                      className="w-full sm:flex-1"
                    />
                  )}

                  {formState.entityType === "virtual_key" && (
                    <VirtualKeySearchableSelect
                      value={formState.entityId}
                      onValueChange={(value) =>
                        setFormState((current) => ({
                          ...current,
                          entityId: value,
                        }))
                      }
                      virtualKeys={virtualKeys}
                      disabled={Boolean(editingLimit)}
                      placeholder="Select virtual key"
                      className="w-full sm:flex-1"
                    />
                  )}

                  {formState.entityType === "agent" && (
                    <AgentSelector
                      mode="single"
                      flat
                      disabled={Boolean(editingLimit)}
                      remote={{
                        filters: {
                          agentType: "agent",
                          searchMode: "name_or_description",
                        },
                      }}
                      value={formState.entityId}
                      onValueChange={(value) =>
                        setFormState((current) => ({
                          ...current,
                          entityId: value,
                        }))
                      }
                      placeholder="Select agent"
                      className="w-full sm:flex-1"
                    />
                  )}

                  {formState.entityType === "llm_oauth_client" && (
                    <SearchableSelect
                      value={formState.entityId}
                      onValueChange={(value) =>
                        setFormState((current) => ({
                          ...current,
                          entityId: value,
                        }))
                      }
                      placeholder="Select OAuth client"
                      disabled={Boolean(editingLimit)}
                      items={oauthClients.map((client) => ({
                        value: client.id,
                        label: client.name,
                        description: client.clientId,
                      }))}
                      className="w-full sm:flex-1"
                    />
                  )}

                  {formState.entityType === "environment" && (
                    <EnvironmentSelector
                      mode="scope"
                      value={formState.entityId}
                      disabled={Boolean(editingLimit)}
                      onChange={(value) =>
                        setFormState((current) => ({
                          ...current,
                          entityId: value,
                        }))
                      }
                      className="w-full sm:flex-1"
                    />
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <Label>Select models</Label>
                {modelOptions.length === 0 ? (
                  <FieldDescription>
                    No model pricing configured.{" "}
                    <Link
                      href="/llm/models"
                      className="underline underline-offset-4"
                    >
                      Add pricing
                    </Link>
                  </FieldDescription>
                ) : (
                  <LlmModelPicker
                    multiple
                    sortDirection="desc"
                    value={formState.isAllModels ? ["all"] : formState.models}
                    onValueChange={(values) => {
                      const isAllModels = values.includes("all");
                      setFormState((current) => ({
                        ...current,
                        models: isAllModels ? [] : values,
                        isAllModels,
                      }));
                    }}
                    models={modelOptions}
                    editable
                    includeAllOption
                  />
                )}
              </div>
            </div>

            <div className="space-y-4 border-t pt-4">
              <div className="grid items-start gap-4 sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1.4fr)]">
                <div className="flex flex-col gap-2">
                  <div className="flex h-5 items-center gap-1.5">
                    <Label htmlFor="limit-kind">Limit kind</Label>
                    {editingLimit && (
                      <LimitFieldHelp label="Limit kind help">
                        Create a new limit to change between spend, tokens and
                        requests.
                      </LimitFieldHelp>
                    )}
                  </div>
                  <Select
                    value={formState.limitType}
                    disabled={Boolean(editingLimit)}
                    onValueChange={(value) =>
                      setFormState((current) => ({
                        ...current,
                        limitType: value as LimitFormState["limitType"],
                        limitValue: "",
                        cleanupInterval: current.hasExplicitInterval
                          ? current.cleanupInterval
                          : value === "token_cost"
                            ? DEFAULT_LIMIT_CLEANUP_INTERVAL
                            : "minute",
                      }))
                    }
                  >
                    <SelectTrigger
                      id="limit-kind"
                      aria-label="Limit kind"
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="token_cost">
                        <LimitKindLabel limitType="token_cost" />
                      </SelectItem>
                      <SelectItem value="tokens">
                        <LimitKindLabel limitType="tokens" />
                      </SelectItem>
                      <SelectItem value="requests">
                        <LimitKindLabel limitType="requests" />
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex h-5 items-center">
                    <Label htmlFor="limit-value">Limit value</Label>
                  </div>
                  <Input
                    id="limit-value"
                    ref={limitValueRef}
                    aria-label="Limit value"
                    aria-describedby={
                      formState.limitValue && !validAmount
                        ? "limit-value-error"
                        : undefined
                    }
                    aria-invalid={Boolean(formState.limitValue) && !validAmount}
                    required
                    value={formState.limitValue}
                    onChange={(event) =>
                      setFormState((current) => ({
                        ...current,
                        limitValue: /^\d{1,3}(,\d{3})+$/.test(
                          event.target.value,
                        )
                          ? event.target.value.replace(/,/g, "")
                          : event.target.value,
                      }))
                    }
                    placeholder={getLimitValuePlaceholder(
                      formState.limitType,
                      formState.cleanupInterval,
                    )}
                    inputMode="numeric"
                  />
                  {formState.limitValue && !validAmount ? (
                    <p
                      id="limit-value-error"
                      className="text-xs text-destructive"
                    >
                      Enter a whole number from 1 to 2,147,483,647. Decimal and
                      negative amounts are not supported.
                    </p>
                  ) : null}
                </div>

                <div className="grid grid-cols-[auto_1fr] grid-rows-[1.25rem_auto] content-start items-center gap-x-1.5 gap-y-2">
                  <Label htmlFor="limit-interval">Interval</Label>
                  <div className="col-span-2 row-start-2">
                    <LimitCleanupIntervalSelect
                      id="limit-interval"
                      ariaLabel="Interval"
                      includeMinute
                      minuteDisabled={
                        Boolean(editingLimit) &&
                        !["organization", "team", "virtual_key"].includes(
                          formState.entityType,
                        )
                      }
                      value={formState.cleanupInterval}
                      onExplicitSelection={() =>
                        setFormState((current) => ({
                          ...current,
                          hasExplicitInterval: true,
                        }))
                      }
                      onValueChange={(value) =>
                        setFormState((current) => ({
                          ...current,
                          cleanupInterval: value,
                          hasExplicitInterval: true,
                        }))
                      }
                    />
                  </div>
                  <LimitFieldHelp
                    label="Interval help"
                    className="col-start-2 row-start-1 justify-self-start"
                  >
                    Per-minute allowance recovers continuously. Rolling
                    intervals reset after elapsed time; calendar intervals reset
                    at the next day, week or month boundary.
                  </LimitFieldHelp>
                </div>
              </div>
              {!(
                formState.limitType === "token_cost" &&
                formState.cleanupInterval !== "minute"
              ) &&
                !["organization", "team", "virtual_key"].includes(
                  formState.entityType,
                ) && (
                  <InlineNotice variant="info">
                    <Info />
                    <InlineNoticeText>
                      Choose an organization, team or virtual key for this
                      allowance.
                    </InlineNoticeText>
                  </InlineNotice>
                )}
              {formState.limitType === "tokens" && (
                <p className="text-sm text-muted-foreground">
                  Counts token usage reported by the provider. Requests in
                  flight can exceed this limit.
                </p>
              )}
            </div>

            <AdvancedLabelsSection
              collapsible
              ref={labelsRef}
              labels={formState.labels}
              onLabelsChange={(labels) =>
                setFormState((current) => ({ ...current, labels }))
              }
            />
          </DialogBody>
          <DialogStickyFooter className="mt-0">
            <Button type="button" variant="outline" onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !canSubmit || createLimit.isPending || updateLimit.isPending
              }
            >
              {editingLimit ? "Save changes" : "Create limit"}
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </FormDialog>

      <DeleteConfirmDialog
        open={!!limitToDelete}
        onOpenChange={(open) => !open && setLimitToDelete(null)}
        title="Delete limit"
        description="This action cannot be undone."
        isPending={deleteLimit.isPending}
        onConfirm={handleDelete}
        confirmLabel="Delete"
        pendingLabel="Deleting..."
      />
      <DeleteConfirmDialog
        open={isBulkDeleteDialogOpen}
        onOpenChange={setIsBulkDeleteDialogOpen}
        title="Delete limits"
        description={`Delete ${selectedLimits.length} ${
          selectedLimits.length === 1 ? "limit" : "limits"
        }? This action cannot be undone.`}
        isPending={bulkDeleteLimits.isPending}
        onConfirm={() => {
          bulkDeleteLimits.mutate(selectedLimits, {
            onSuccess: (outcome) => {
              reportBulkOutcome({
                outcome,
                verb: "Deleted",
                failureVerb: "delete",
                noun: "limit",
              });
              setIsBulkDeleteDialogOpen(false);
              if (outcome.failed.length === 0) clearSelection();
            },
          });
        }}
        confirmLabel="Delete limits"
        pendingLabel="Deleting..."
      />
    </div>
  );
}

export function getLimitModels(limit: LimitData): string[] {
  return Array.isArray(limit.model)
    ? limit.model.filter((model): model is string => typeof model === "string")
    : [];
}

function formatNextLimitReset(
  lastCleanup: LimitData["lastCleanup"],
  cleanupInterval: LimitCleanupInterval,
): string {
  if (cleanupInterval === "minute") return "";
  if (isCalendarCleanupInterval(cleanupInterval)) {
    return formatResetDate(
      getNextCalendarResetDate(new Date(), cleanupInterval),
    );
  }

  if (!lastCleanup) {
    return "Resets on next check";
  }

  const nextReset = addCleanupInterval(new Date(lastCleanup), cleanupInterval);
  if (Number.isNaN(nextReset.getTime())) {
    return "Reset schedule unavailable";
  }

  return formatResetDate(nextReset);
}

function formatResetDate(date: Date): string {
  return `Resets ${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  })}`;
}

function addCleanupInterval(
  date: Date,
  cleanupInterval: LimitCleanupInterval,
): Date {
  const next = new Date(date);
  switch (cleanupInterval) {
    case "minute":
      return new Date(Math.floor(date.getTime() / 60000) * 60000 + 60000);
    case "1h":
      next.setHours(next.getHours() + 1);
      return next;
    case "12h":
      next.setHours(next.getHours() + 12);
      return next;
    case "24h":
      next.setDate(next.getDate() + 1);
      return next;
    case "1w":
      next.setDate(next.getDate() + 7);
      return next;
    case "1m":
      next.setMonth(next.getMonth() + 1);
      return next;
    case "calendar_day":
    case "calendar_week_sunday":
    case "calendar_week_monday":
    case "calendar_month":
      return getNextCalendarResetDate(next, cleanupInterval);
  }
}

function isCalendarCleanupInterval(
  cleanupInterval: LimitCleanupInterval,
): cleanupInterval is Extract<
  LimitCleanupInterval,
  | "calendar_day"
  | "calendar_week_sunday"
  | "calendar_week_monday"
  | "calendar_month"
> {
  return cleanupInterval.startsWith("calendar_");
}

function getNextCalendarResetDate(
  date: Date,
  cleanupInterval: Extract<
    LimitCleanupInterval,
    | "calendar_day"
    | "calendar_week_sunday"
    | "calendar_week_monday"
    | "calendar_month"
  >,
): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);

  switch (cleanupInterval) {
    case "calendar_day":
      next.setDate(next.getDate() + 1);
      return next;
    case "calendar_week_sunday": {
      const daysUntilSunday = (7 - next.getDay()) % 7 || 7;
      next.setDate(next.getDate() + daysUntilSunday);
      return next;
    }
    case "calendar_week_monday": {
      const daysUntilMonday = (8 - next.getDay()) % 7 || 7;
      next.setDate(next.getDate() + daysUntilMonday);
      return next;
    }
    case "calendar_month":
      next.setMonth(next.getMonth() + 1, 1);
      return next;
  }
}

const USAGE_STATUSES: UsageStatus[] = ["safe", "warning", "danger"];

// The labels keep this page's existing thresholds (see getUsageStatus).
// Disabled reference queries keep stable defaults so dialog state changes do
// not replace table cells and detach the button that should regain focus.
const EMPTY_ENTITY_OPTIONS: never[] = [];

const USAGE_STATUS_META: Record<
  UsageStatus,
  { label: string; hint: string; dotClassName: string }
> = {
  safe: {
    label: "Within limit",
    hint: "Under 75% used",
    dotClassName: "bg-emerald-500",
  },
  warning: {
    label: "Near limit",
    hint: "75% to under 90% used",
    dotClassName: "bg-amber-500",
  },
  danger: {
    label: "Critical",
    hint: "90% or more used",
    dotClassName: "bg-destructive",
  },
};

const ENTITY_SCOPE_LABELS: Partial<Record<LimitEntityType, string>> = {
  organization: "Organization",
  team: "Team",
  agent: "Agent",
  user: "User",
  virtual_key: "Virtual key",
  llm_oauth_client: "LLM OAuth client",
  environment: "Environment",
};

const APPLIED_TO_OPTIONS: Array<{
  value: string;
  label: string;
  icon: LucideIcon;
}> = [
  { value: "organization", label: "Organization", icon: Building2 },
  { value: "team", label: "Team", icon: Users },
  { value: "agent", label: "Agent", icon: Bot },
  { value: "user", label: "User", icon: User },
  { value: "virtual_key", label: "Virtual key", icon: Key },
  { value: "llm_oauth_client", label: "LLM OAuth client", icon: KeyRound },
  { value: "environment", label: "Environment", icon: Boxes },
];

function UsageStatusDot({ status }: { status: UsageStatus }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        USAGE_STATUS_META[status].dotClassName,
      )}
    />
  );
}

/** A filter option with its icon, an optional hint, and how many limits match. */
function FilterOptionLabel({
  icon,
  label,
  hint,
  count,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  count: number;
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-2",
        count === 0 && "text-muted-foreground",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {hint && (
          <span className="block text-xs text-muted-foreground">{hint}</span>
        )}
      </span>
      <span className="text-xs tabular-nums text-muted-foreground">
        {count}
      </span>
    </span>
  );
}

function LimitModels({
  models,
  modelByModelId,
}: {
  models: string[];
  modelByModelId: Map<string, LimitFilterModel>;
}) {
  if (models.length === 0) {
    return (
      <span
        className="text-sm text-muted-foreground"
        data-testid="limits-table-models-badge"
      >
        All models
      </span>
    );
  }
  const visible = models.slice(0, MAX_VISIBLE_MODEL_BADGES);
  const remaining = models.slice(MAX_VISIBLE_MODEL_BADGES);
  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((model) => {
        const known = modelByModelId.get(model);
        return (
          <Badge
            key={model}
            variant="secondary"
            className="gap-1 text-xs font-normal"
            data-testid="limits-table-models-badge"
            title={model}
          >
            {known && (
              <ModelSelectorLogo
                provider={logoNameForProvider(known.provider)}
                className="size-3"
              />
            )}
            {known?.displayName ?? model}
          </Badge>
        );
      })}
      {remaining.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="cursor-default text-xs font-normal"
              data-testid="limits-table-models-more-badge"
            >
              +{remaining.length} more
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-80">
            <div className="space-y-1">
              {remaining.map((model) => (
                <div key={model}>
                  {modelByModelId.get(model)?.displayName ?? model}
                </div>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

/** Usage and recovery are formatted from each rule's units and interval. */
function LimitUsage({
  limit,
  usage,
}: {
  limit: LimitData;
  usage: UsageSummary;
}) {
  const cleanupInterval = getLimitInterval(limit);
  const known =
    limit.limitType === "token_cost" || Boolean(limit.throughputUsage);
  const status = !known
    ? "Usage unavailable"
    : usage.actualUsage === usage.actualLimit
      ? "At limit"
      : usage.actualUsage > usage.actualLimit
        ? "Over limit"
        : null;
  return (
    <div className="min-w-0 w-full space-y-1 overflow-hidden">
      {known && (
        <div
          role="progressbar"
          aria-label={`${limitMetricLabel(limit)} usage`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.max(Math.min(usage.percentage, 100), 0)}
          aria-valuetext={`${usage.percentage.toFixed(1)}% used`}
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn(
              "h-full rounded-full",
              USAGE_STATUS_META[usage.status].dotClassName,
            )}
            style={{
              width: `${Math.max(Math.min(usage.percentage, 100), 1.5)}%`,
            }}
          />
        </div>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs">
        <p className="truncate tabular-nums">
          <span>
            {known
              ? limit.limitType === "token_cost"
                ? formatCurrency(usage.actualUsage, 2)
                : usage.actualUsage.toLocaleString(undefined, {
                    maximumFractionDigits: 1,
                  })
              : "—"}
          </span>
          <span className="text-muted-foreground">
            {` of ${formatLimitAmount(limit, usage.actualLimit)}${known ? ` (${usage.percentage.toFixed(1)}%)` : ""}`}
          </span>
        </p>
        {status && (
          <p
            className={cn(
              "text-xs",
              usage.actualUsage >= usage.actualLimit && known
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {status}
          </p>
        )}
      </div>
      <p className="truncate text-xs text-muted-foreground">
        {CLEANUP_INTERVAL_LABELS[cleanupInterval]}
        {cleanupInterval !== "minute" && (
          <>
            {" · "}
            {limit.throughputUsage?.resetsAt
              ? formatResetDate(new Date(limit.throughputUsage.resetsAt))
              : formatNextLimitReset(limit.lastCleanup, cleanupInterval)}
          </>
        )}
      </p>
    </div>
  );
}

function LimitKindLabel({ limitType }: { limitType: LimitData["limitType"] }) {
  const isRequests =
    limitType === "requests" || limitType === "requests_per_minute";
  const Icon =
    limitType === "token_cost"
      ? CircleDollarSign
      : isRequests
        ? ArrowRightLeft
        : Coins;
  const label =
    limitType === "token_cost" ? "Spend" : isRequests ? "Requests" : "Tokens";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Icon
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <span>{label}</span>
    </span>
  );
}

function limitMetricLabel(limit: LimitData) {
  return limit.limitType === "token_cost"
    ? "Spend"
    : limit.limitType === "requests_per_minute" ||
        limit.limitType === "requests"
      ? "Requests"
      : "Tokens";
}
function formatLimitAmount(
  limit: LimitData,
  value: number,
  fractionDigits = 0,
) {
  if (limit.limitType === "token_cost")
    return formatCurrency(value, fractionDigits);
  return `${value.toLocaleString()} ${limitMetricLabel(limit).toLowerCase()}`;
}

function getLimitInterval(limit: LimitData): LimitCleanupInterval {
  if (
    limit.limitType === "requests_per_minute" ||
    limit.limitType === "tokens_per_minute"
  ) {
    return "minute";
  }
  return limit.cleanupInterval ?? DEFAULT_LIMIT_CLEANUP_INTERVAL;
}

function LimitFieldHelp({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(
            "text-muted-foreground hover:text-foreground",
            className,
          )}
          aria-label={label}
        >
          <Info aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent align="start" className="max-w-60 text-wrap">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
