"use client";

import { type archestraApiTypes, DocsPage } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Bot,
  Boxes,
  Building2,
  CircleDollarSign,
  Edit,
  Info,
  Key,
  KeyRound,
  type LucideIcon,
  Network,
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
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EntityLabelFilter } from "@/components/entity-label-filter";
import { EnvironmentSelector } from "@/components/environment-selector";
import { ExternalDocsLink } from "@/components/external-docs-link";
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
  CLEANUP_INTERVAL_LABELS,
  DEFAULT_LIMIT_CLEANUP_INTERVAL,
  type LimitCleanupInterval,
  LimitCleanupIntervalSelect,
} from "@/components/limit-cleanup-interval-select";
import { LlmModelPicker } from "@/components/llm-model-picker";
import { QueryLoadError } from "@/components/query-load-error";
import { WithPermissions } from "@/components/roles/with-permissions";
import { TableRowActions } from "@/components/table-row-actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UserSearchableSelect } from "@/components/user-searchable-select";
import { VirtualKeySearchableSelect } from "@/components/virtual-key-searchable-select";
import { useProfiles } from "@/lib/agent.query";
import { reportBulkOutcome } from "@/lib/bulk-action";
import { useDefaultUserLimits } from "@/lib/default-user-limit.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
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
import { useModelsWithApiKeys } from "@/lib/llm-models.query";
import { useLlmOauthClients } from "@/lib/llm-oauth-clients.query";
import { useLlmProxy } from "@/lib/llm-proxy.query";
import {
  useOrganization,
  useOrganizationMembers,
} from "@/lib/organization.query";
import { logoNameForProvider } from "@/lib/provider-logos";
import { useTeams } from "@/lib/teams/team.query";
import { cn } from "@/lib/utils/tailwind";
import { useAllVirtualApiKeys } from "@/lib/virtual-api-keys.query";

type LimitData = archestraApiTypes.GetLimitsResponses["200"][number];
type LimitEntityType = archestraApiTypes.CreateLimitData["body"]["entityType"];
type UsageStatus = "safe" | "warning" | "danger";
type UsageSummary = {
  percentage: number;
  status: UsageStatus;
  actualUsage: number;
  actualLimit: number;
};

const canBulkDeleteLimit = (limit: LimitData) => limit.entityType !== "user";

// llm_proxy is a type of agent
// It is more convenient and clear to handle it as a separate entity on the frontend
type LimitFormEntityType = LimitEntityType | "llm_proxy";

type LimitFormState = {
  entityType: LimitFormEntityType;
  entityId: string;
  limitValue: string;
  cleanupInterval: LimitCleanupInterval;
  models: string[];
  isAllModels: boolean;
  labels: ProfileLabel[];
};

const DEFAULT_FORM_STATE: LimitFormState = {
  entityType: "organization",
  entityId: "",
  limitValue: "",
  cleanupInterval: DEFAULT_LIMIT_CLEANUP_INTERVAL,
  models: [],
  isAllModels: true,
  labels: [],
};

const LIMITS_ENTITY_SELECTOR_PAGE_SIZE = 100;
const MAX_VISIBLE_MODEL_BADGES = 3;

const ENTITY_TYPE_ITEMS: Array<{
  value: LimitFormEntityType;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    value: "organization",
    label: "Organization",
    description: "A shared budget across all LLM spend in your organization.",
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
    value: "llm_proxy",
    label: "LLM Proxy",
    description: "Caps spend routed through the LLM Proxy.",
    icon: <Network className="h-4 w-4 shrink-0 text-muted-foreground" />,
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

function formatNumericInput(value: string) {
  if (!value) return "";
  return Number(value).toLocaleString("en-US");
}

import {
  type LimitFilterModel,
  LimitModelFilter,
} from "./_parts/limit-model-filter";
import { type NestedLimit, nestLimits } from "./_parts/nest-limits";

export default function LimitsPage() {
  const setActionButton = useSetCostsAction();
  const {
    data: limits = [],
    isPending,
    isFetching,
    isLoadingError: isLimitsLoadError,
    refetch: refetchLimits,
  } = useLimits();
  const { data: teams = [] } = useTeams();
  const { data: organization } = useOrganization();
  const { data: members = [] } = useOrganizationMembers();
  const { data: defaultUserLimits = [] } = useDefaultUserLimits();
  const { data: virtualKeysData } = useAllVirtualApiKeys({
    limit: LIMITS_ENTITY_SELECTOR_PAGE_SIZE,
  });
  const virtualKeys = virtualKeysData?.data ?? [];
  const { data: oauthClientsData } = useLlmOauthClients({
    limit: LIMITS_ENTITY_SELECTOR_PAGE_SIZE,
  });
  const oauthClients = oauthClientsData?.data ?? [];
  const { data: agents = [] } = useProfiles({
    filters: { agentTypes: ["agent"] },
  });
  const { data: llmProxy, isPending: llmProxyPending } = useLlmProxy();
  const llmProxyId = llmProxy?.id ?? null;
  const { data: environmentsData } = useEnvironments();
  const environments = environmentsData?.environments ?? [];
  const { data: modelsWithApiKeys = [] } = useModelsWithApiKeys();
  const createLimit = useCreateLimit();
  const updateLimit = useUpdateLimit();
  const deleteLimit = useDeleteLimit();
  const bulkDeleteLimits = useBulkDeleteLimits();

  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const statusFilter = searchParams.get("status") || "all";
  const appliedToFilter = searchParams.get("appliedTo") || "all";
  const modelFilter = searchParams.get("model") || "all";
  const labelsFilter = searchParams.get("labels") || "";
  const selectedLabels = useSelectedLabels();
  const [limitToDelete, setLimitToDelete] = useState<LimitData | null>(null);
  const [isBulkDeleteDialogOpen, setIsBulkDeleteDialogOpen] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [formState, setFormState] =
    useState<LimitFormState>(DEFAULT_FORM_STATE);
  const labelsRef = useRef<ProfileLabelsRef>(null);

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
    () => limits.filter((limit) => limit.limitType === "token_cost"),
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

  const buildEditFormState = useCallback(
    (limit: LimitData): LimitFormState => {
      const models = getLimitModels(limit);
      const isAllModels =
        models.length === 0 && limit.limitType === "token_cost";

      let entityType: LimitFormEntityType = limit.entityType;
      if (limit.entityType === "agent" && limit.entityId === llmProxyId) {
        entityType = "llm_proxy";
      }

      return {
        entityType,
        entityId: limit.entityType === "organization" ? "" : limit.entityId,
        limitValue: String(limit.limitValue),
        cleanupInterval:
          limit.cleanupInterval ?? DEFAULT_LIMIT_CLEANUP_INTERVAL,
        models: isAllModels ? [] : models,
        isAllModels,
        labels: limit.labels,
      };
    },
    [llmProxyId],
  );

  // Seed the edit form exactly once per opened limit — row clicks and deep
  // links share this path. Keyed on the opened id rather than
  // buildEditFormState, whose llmProxies dep changes on refetch and would
  // otherwise wipe in-progress edits.
  const seededEditIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!editingLimit) {
      seededEditIdRef.current = null;
      return;
    }
    if (seededEditIdRef.current === editingLimit.id) {
      return;
    }
    // Classifying an agent-typed limit as agent vs LLM Proxy needs the proxy
    // id. Seeding (and locking the ref) before it loads would misclassify an
    // LLM Proxy limit as "agent" and never reseed once it arrives.
    if (editingLimit.entityType === "agent" && llmProxyPending) {
      return;
    }
    seededEditIdRef.current = editingLimit.id;
    setFormState(buildEditFormState(editingLimit));
  }, [editingLimit, buildEditFormState, llmProxyPending]);

  const getEntityLabel = useCallback(
    (limit: LimitData) => {
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
        if (limit.entityId === llmProxyId) {
          return "LLM Proxy";
        }
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
    [
      teams,
      members,
      virtualKeys,
      oauthClients,
      agents,
      llmProxyId,
      environments,
    ],
  );

  const getEntityIcon = useCallback(
    (limit: LimitData) => {
      const iconClassName = "h-4 w-4 shrink-0 text-muted-foreground";
      if (limit.entityType === "organization") {
        return <Building2 className={iconClassName} />;
      }
      if (limit.entityType === "team") {
        return <Users className={iconClassName} />;
      }
      if (limit.entityType === "user") {
        return <User className={iconClassName} />;
      }
      if (limit.entityType === "virtual_key") {
        return <Key className={iconClassName} />;
      }
      if (limit.entityType === "llm_oauth_client") {
        return <KeyRound className={iconClassName} />;
      }
      if (limit.entityType === "environment") {
        return <Boxes className={iconClassName} />;
      }
      if (limit.entityType === "agent" && limit.entityId === llmProxyId) {
        return <Network className={iconClassName} />;
      }
      return (
        <AgentIcon icon={null} fallbackType="agent" className={iconClassName} />
      );
    },
    [llmProxyId],
  );

  const getEntityScopeLabel = useCallback(
    (limit: LimitData) => {
      if (limit.entityType === "agent") {
        return limit.entityId === llmProxyId ? "LLM Proxy" : "Agent";
      }
      return ENTITY_SCOPE_LABELS[limit.entityType] ?? "Limit";
    },
    [llmProxyId],
  );

  const getUsageStatus = useCallback((limit: LimitData): UsageSummary => {
    const actualUsage = (limit.modelUsage ?? []).reduce(
      (sum, usage) => sum + usage.cost,
      0,
    );
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
      const matchesAppliedTo =
        appliedToFilter === "all" ||
        (appliedToFilter === "agent" &&
          limit.entityType === "agent" &&
          limit.entityId !== llmProxyId) ||
        (appliedToFilter === "llm_proxy" &&
          limit.entityType === "agent" &&
          limit.entityId === llmProxyId) ||
        (appliedToFilter !== "agent" &&
          appliedToFilter !== "llm_proxy" &&
          limit.entityType === appliedToFilter);
      const isAllModelsLimit =
        limit.limitType === "token_cost" &&
        (!limit.model ||
          (Array.isArray(limit.model) && limit.model.length === 0));
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

      return matchesStatus && matchesAppliedTo && matchesModel && matchesLabels;
    });
  }, [
    appliedToFilter,
    llmLimits,
    modelFilter,
    statusFilter,
    getUsageStatus,
    llmProxyId,
    selectedLabels,
  ]);

  const nestedLimits = useMemo(
    () =>
      nestLimits({
        limits: filteredLimits,
        entityKeyOf: (limit) =>
          limit.entityType === "organization"
            ? "organization"
            : `${limit.entityType}:${limit.entityId}`,
        parentKeysOf: (limit) => {
          if (limit.entityType === "organization") return [];
          // A key or client nests under the team that pays for it.
          const billingTeamId =
            limit.entityType === "virtual_key"
              ? virtualKeys.find((key) => key.id === limit.entityId)
                  ?.billingTeam?.id
              : limit.entityType === "llm_oauth_client"
                ? oauthClients.find((client) => client.id === limit.entityId)
                    ?.billingTeam?.id
                : undefined;
          return billingTeamId
            ? [`team:${billingTeamId}`, "organization"]
            : ["organization"];
        },
        prefersAsParent: (limit) => getLimitModels(limit).length === 0,
      }),
    [filteredLimits, virtualKeys, oauthClients],
  );

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
      appliedToFilter,
      modelFilter,
      labelsFilter,
    }),
    matchDescription: "match the current filters",
  });

  const columns = useMemo<ColumnDef<NestedLimit<LimitData>>[]>(
    () => [
      createSelectColumn<NestedLimit<LimitData>>({
        rowLabel: ({ limit }) => `Select ${getEntityLabel(limit)} limit`,
        allLabel: "Select all limits on this page",
        canSelect: ({ limit }) => canBulkDeleteLimit(limit),
        disabledReason: () =>
          "User limits must be deleted individually because they can span organizations",
      }),
      {
        id: "entityId",
        header: "Applied to",
        size: 220,
        minSize: 160,
        cell: ({ row }) => {
          const { limit, depth } = row.original;
          return (
            <div
              className="flex min-w-0 items-center gap-2"
              style={{ paddingLeft: `${Math.max(depth - 1, 0) * 20}px` }}
            >
              {depth > 0 && (
                <span
                  aria-hidden
                  className="mb-2 size-2.5 shrink-0 rounded-bl-sm border-b border-l border-muted-foreground/40"
                />
              )}
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
            models={getLimitModels(row.original.limit)}
            modelByModelId={modelByModelId}
          />
        ),
      },
      {
        id: "usage",
        header: "Usage",
        size: 320,
        minSize: 240,
        cell: ({ row }) => (
          <LimitUsage
            nested={row.original}
            usage={getUsageStatus(row.original.limit)}
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
            actions={[
              {
                icon: <Edit className="h-4 w-4" />,
                label: "Edit limit",
                onClick: () => openEditDialog(row.original.limit),
              },
              {
                icon: <Trash2 className="h-4 w-4" />,
                label: "Delete limit",
                variant: "destructive",
                onClick: () => setLimitToDelete(row.original.limit),
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
      const key =
        limit.entityType === "agent" && limit.entityId === llmProxyId
          ? "llm_proxy"
          : limit.entityType;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [llmLimits, llmProxyId]);
  const attentionLimits = useMemo(
    () =>
      llmLimits
        .map((limit) => ({ limit, usage: getUsageStatus(limit) }))
        .filter(({ usage }) => usage.status !== "safe")
        .sort((a, b) => b.usage.percentage - a.usage.percentage),
    [llmLimits, getUsageStatus],
  );

  const hasActiveFilters =
    statusFilter !== "all" ||
    appliedToFilter !== "all" ||
    modelFilter !== "all" ||
    Boolean(labelsFilter);
  const clearFilters = useCallback(
    () =>
      updateQueryParams({
        status: null,
        appliedTo: null,
        model: null,
        labels: null,
      }),
    [updateQueryParams],
  );
  const shouldShowDefaultUserLimitNotice =
    formState.entityType === "user" && defaultUserLimits.length > 0;
  const limitsDocsUrl = getFrontendDocsUrl(
    DocsPage.PlatformCostsAndLimits,
    "usage-limits",
  );

  function closeDialog() {
    if (editingLimit) {
      closeEditDialog();
    } else {
      setIsCreateDialogOpen(false);
    }
  }

  async function handleSubmit() {
    const finalLabels =
      labelsRef.current?.saveUnsavedLabel() ?? formState.labels;
    const entityType =
      formState.entityType === "llm_proxy" ? "agent" : formState.entityType;
    const body = {
      entityType,
      entityId:
        formState.entityType === "organization"
          ? (organization?.id ?? "")
          : formState.entityType === "llm_proxy"
            ? (llmProxyId ?? "")
            : formState.entityId,
      limitType: "token_cost" as const,
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

  const canSubmit =
    Number(formState.limitValue) > 0 &&
    (formState.isAllModels || formState.models.length > 0) &&
    (formState.entityType === "organization" ||
      (formState.entityType === "llm_proxy"
        ? !!llmProxyId
        : formState.entityId.length > 0));

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
    <div>
      <WithPermissions
        permissions={{ llmLimit: ["read"] }}
        noPermissionHandle="hide"
      >
        <Alert variant="info" className="mb-4">
          <AlertDescription className="block">
            {defaultUserLimits.length > 0
              ? "A default user limit applies to every user. Custom per-user limits override it. Configure it in "
              : "No default user limit is set — users are only capped by the custom limits below. Set a default for every user in "}
            <Link
              href="/settings/llm"
              className="font-medium underline underline-offset-4"
            >
              LLM settings
            </Link>
            .
          </AlertDescription>
        </Alert>
      </WithPermissions>

      {attentionLimits.length > 0 && (
        <NeedsAttention
          items={attentionLimits.map(({ limit, usage }) => ({
            limit,
            usage,
            label: getEntityLabel(limit),
            scopeLabel: getEntityScopeLabel(limit),
            icon: getEntityIcon(limit),
            models: getLimitModels(limit).map(
              (model) => modelByModelId.get(model)?.displayName ?? model,
            ),
          }))}
          onEdit={openEditDialog}
        />
      )}

      <BulkActionsScope>
        <CollectionFilters>
          <FilterBar
            onClearFilters={hasActiveFilters ? clearFilters : undefined}
          >
            <FilterSelect
              value={statusFilter}
              onValueChange={(value) =>
                updateQueryParams({ status: value === "all" ? null : value })
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
                updateQueryParams({ appliedTo: value === "all" ? null : value })
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
            <LimitModelFilter
              value={modelFilter}
              onValueChange={(value) =>
                updateQueryParams({ model: value === "all" ? null : value })
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
          data={nestedLimits}
          getRowId={({ limit }) => limit.id}
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

      <FormDialog
        open={isCreateDialogOpen || !!editingLimit}
        onOpenChange={(open) => !open && closeDialog()}
        title={editingLimit ? "Edit limit" : "Create limit"}
        description="Configure scoped LLM token-cost limits."
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
            <Alert variant="info">
              <Info className="h-4 w-4" />
              <AlertDescription className="block">
                A limit caps token-cost spend for the selected scope over a
                recurring window. Limits stack: when more than one applies to a
                request, every matching limit is checked and the request is
                blocked if any is exceeded.
                {limitsDocsUrl && (
                  <>
                    {" "}
                    <ExternalDocsLink
                      href={limitsDocsUrl}
                      className="text-inherit underline underline-offset-4"
                      showIcon={false}
                    >
                      Learn how limits are evaluated
                    </ExternalDocsLink>
                    .
                  </>
                )}
              </AlertDescription>
            </Alert>

            {shouldShowDefaultUserLimitNotice && (
              <Alert variant="info">
                <AlertDescription>
                  This custom user limit will override the default user limit
                  for the selected user.
                </AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label>Apply to</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <SearchableSelect
                  value={formState.entityType}
                  onValueChange={(value) =>
                    setFormState((current) => ({
                      ...current,
                      entityType: value as LimitFormEntityType,
                      entityId: "",
                    }))
                  }
                  placeholder="Select scope"
                  items={ENTITY_TYPE_ITEMS.map((item) => ({
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
                          {item.description}
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
                  />
                )}

                {formState.entityType === "user" && (
                  <UserSearchableSelect
                    value={formState.entityId}
                    onValueChange={(value) =>
                      setFormState((current) => ({
                        ...current,
                        entityId: value,
                      }))
                    }
                    users={members.map((member) => ({
                      userId: member.id,
                      name: member.name,
                      email: member.email,
                    }))}
                    placeholder="Select user"
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
                    placeholder="Select virtual key"
                    className="w-full sm:flex-1"
                  />
                )}

                {formState.entityType === "agent" && (
                  <SearchableSelect
                    value={formState.entityId}
                    onValueChange={(value) =>
                      setFormState((current) => ({
                        ...current,
                        entityId: value,
                      }))
                    }
                    placeholder="Select agent"
                    items={agents.map((agent) => ({
                      value: agent.id,
                      label: agent.name,
                      description: agent.description ?? undefined,
                    }))}
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
            </div>

            <div className="space-y-2">
              <Label>Limit value ($)</Label>
              <Input
                aria-label="Limit value"
                value={formatNumericInput(formState.limitValue)}
                onChange={(event) =>
                  setFormState((current) => ({
                    ...current,
                    limitValue: event.target.value.replace(/[^0-9]/g, ""),
                  }))
                }
                placeholder="1,000"
                inputMode="numeric"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <Label>Cleanup interval</Label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="h-5 w-5 text-muted-foreground hover:text-foreground"
                      aria-label="Cleanup interval help"
                    >
                      <Info className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" align="start" className="max-w-72">
                    Rolling resets after elapsed time. Calendar resets at the
                    next day, week, or month boundary.
                  </TooltipContent>
                </Tooltip>
              </div>
              <LimitCleanupIntervalSelect
                value={formState.cleanupInterval}
                onValueChange={(value) =>
                  setFormState((current) => ({
                    ...current,
                    cleanupInterval: value,
                  }))
                }
              />
            </div>

            <AdvancedLabelsSection
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
const USAGE_STATUS_META: Record<
  UsageStatus,
  { label: string; hint: string; barClassName: string; dotClassName: string }
> = {
  safe: {
    label: "Safe",
    hint: "Under 75% used",
    barClassName: "bg-emerald-500",
    dotClassName: "bg-emerald-500",
  },
  warning: {
    label: "Near limit",
    hint: "75% or more used",
    barClassName: "bg-amber-500",
    dotClassName: "bg-amber-500",
  },
  danger: {
    label: "Exceeded",
    hint: "90% or more used",
    barClassName: "bg-destructive",
    dotClassName: "bg-destructive",
  },
};

const ENTITY_SCOPE_LABELS: Partial<Record<LimitEntityType, string>> = {
  organization: "Organization",
  team: "Team",
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
  { value: "llm_proxy", label: "LLM Proxy", icon: Network },
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

/**
 * The usage bar, colored by status, with the spend and when it resets. A
 * parent row adds how much of its limit the limits nested under it take.
 */
function LimitUsage({
  nested,
  usage,
}: {
  nested: NestedLimit<LimitData>;
  usage: UsageSummary;
}) {
  const { limit, allocation } = nested;
  const cleanupInterval =
    (limit.cleanupInterval as LimitCleanupInterval | null) ??
    DEFAULT_LIMIT_CLEANUP_INTERVAL;
  const overAllocated = allocation
    ? allocation.total > limit.limitValue
    : false;
  return (
    <div className="min-w-0 w-full space-y-1 overflow-hidden">
      <UsageBar percentage={usage.percentage} status={usage.status} />
      <p className="truncate text-xs">
        <span>{formatCurrency(usage.actualUsage, 2)}</span>
        <span className="text-muted-foreground">
          {` of ${formatCurrency(usage.actualLimit)} (${usage.percentage.toFixed(1)}%)`}
        </span>
      </p>
      <p className="truncate text-xs text-muted-foreground">
        {`${CLEANUP_INTERVAL_LABELS[cleanupInterval]} · ${formatNextLimitReset(limit.lastCleanup, cleanupInterval)}`}
      </p>
      {allocation && allocation.count > 0 && (
        <p
          className={cn(
            "text-xs",
            overAllocated
              ? "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground",
          )}
        >
          {overAllocated
            ? `Nested caps: ${formatCurrency(allocation.total)}, more than this limit`
            : `Nested caps: ${formatCurrency(allocation.total)} of ${formatCurrency(limit.limitValue)}`}
          {` (${allocation.count} ${allocation.count === 1 ? "limit" : "limits"})`}
          {allocation.otherPeriodCount > 0 &&
            ` · ${allocation.otherPeriodCount} more on another period`}
        </p>
      )}
      {allocation &&
        allocation.count === 0 &&
        allocation.otherPeriodCount > 0 && (
          <p className="text-xs text-muted-foreground">
            {`${allocation.otherPeriodCount} nested ${allocation.otherPeriodCount === 1 ? "limit resets" : "limits reset"} on another period`}
          </p>
        )}
    </div>
  );
}

function UsageBar({
  percentage,
  status,
}: {
  percentage: number;
  status: UsageStatus;
}) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn(
          "h-full rounded-full",
          USAGE_STATUS_META[status].barClassName,
        )}
        style={{ width: `${Math.max(Math.min(percentage, 100), 1.5)}%` }}
      />
    </div>
  );
}

/** Limits at 75% or more, as cards that say what happens next. */
function NeedsAttention({
  items,
  onEdit,
}: {
  items: Array<{
    limit: LimitData;
    usage: UsageSummary;
    label: string;
    scopeLabel: string;
    icon: React.ReactNode;
    models: string[];
  }>;
  onEdit: (limit: LimitData) => void;
}) {
  return (
    <section
      aria-labelledby="limits-needs-attention"
      className="mb-6 space-y-3"
    >
      <h2
        id="limits-needs-attention"
        className="flex items-center gap-2 text-sm font-medium"
      >
        Needs attention
        <span className="text-muted-foreground tabular-nums">
          {items.length}
        </span>
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map(({ limit, usage, label, scopeLabel, icon, models }) => {
          const cleanupInterval =
            (limit.cleanupInterval as LimitCleanupInterval | null) ??
            DEFAULT_LIMIT_CLEANUP_INTERVAL;
          const reset = formatNextLimitReset(
            limit.lastCleanup,
            cleanupInterval,
          );
          const over = usage.actualUsage >= usage.actualLimit;
          return (
            <article
              key={limit.id}
              className="space-y-3 rounded-lg border p-4"
              data-testid={`limits-attention-${limit.id}`}
            >
              <div className="flex items-start gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded bg-muted">
                  {icon}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{label}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {scopeLabel} ·{" "}
                    {models.length > 0 ? models.join(", ") : "All models"}
                  </div>
                </div>
                <span className="flex shrink-0 items-center gap-1.5 text-xs">
                  <UsageStatusDot status={usage.status} />
                  {USAGE_STATUS_META[usage.status].label}
                </span>
              </div>
              <UsageBar percentage={usage.percentage} status={usage.status} />
              <p className="text-sm text-muted-foreground">
                {over
                  ? `Over by ${formatCurrency(usage.actualUsage - usage.actualLimit, 2)}. Requests are blocked. ${reset}.`
                  : `${formatCurrency(usage.actualLimit - usage.actualUsage, 2)} of ${formatCurrency(usage.actualLimit)} left. ${reset}.`}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onEdit(limit)}
              >
                <Edit className="h-4 w-4" />
                Edit limit
              </Button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
