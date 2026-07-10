"use client";

import { type archestraApiTypes, DocsPage } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Boxes,
  Building2,
  Edit,
  Info,
  Key,
  Network,
  Plus,
  Trash2,
  User,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSetCostsAction } from "@/app/llm/(costs)/layout";
import { AgentIcon } from "@/components/agent-icon";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EnvironmentScopeSelect } from "@/components/environment-scope-select";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { FormDialog } from "@/components/form-dialog";
import {
  CLEANUP_INTERVAL_LABELS,
  DEFAULT_LIMIT_CLEANUP_INTERVAL,
  type LimitCleanupInterval,
  LimitCleanupIntervalSelect,
} from "@/components/limit-cleanup-interval-select";
import { LlmModelPicker } from "@/components/llm-model-picker";
import { LlmModelSearchableSelect } from "@/components/llm-model-select";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { QueryLoadError } from "@/components/query-load-error";
import { WithPermissions } from "@/components/roles/with-permissions";
import { TableRowActions } from "@/components/table-row-actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Progress } from "@/components/ui/progress";
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
import { UserSearchableSelect } from "@/components/user-searchable-select";
import { VirtualKeySearchableSelect } from "@/components/virtual-key-searchable-select";
import { useProfiles } from "@/lib/agent.query";
import { useDefaultUserLimits } from "@/lib/default-user-limit.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useEnvironments } from "@/lib/environment.query";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import {
  useCreateLimit,
  useDeleteLimit,
  useLimits,
  useUpdateLimit,
} from "@/lib/limits.query";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";
import {
  useOrganization,
  useOrganizationMembers,
} from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";
import { useAllVirtualApiKeys } from "@/lib/virtual-api-keys.query";

type LimitData = archestraApiTypes.GetLimitsResponses["200"][number];
type LimitEntityType = archestraApiTypes.CreateLimitData["body"]["entityType"];
type UsageStatus = "safe" | "warning" | "danger";

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
};

const DEFAULT_FORM_STATE: LimitFormState = {
  entityType: "organization",
  entityId: "",
  limitValue: "",
  cleanupInterval: DEFAULT_LIMIT_CLEANUP_INTERVAL,
  models: [],
  isAllModels: true,
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
    description: "Caps spend for a single LLM proxy.",
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
    value: "environment",
    label: "Environment",
    description:
      "Caps the combined spend of all users in a deployment environment (e.g. production).",
    icon: <Boxes className="h-4 w-4 shrink-0 text-muted-foreground" />,
  },
];

function formatCurrencyWhole(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatNumericInput(value: string) {
  if (!value) return "";
  return Number(value).toLocaleString("en-US");
}

export default function LimitsPage() {
  const setActionButton = useSetCostsAction();
  const {
    data: limits = [],
    isPending,
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
  const { data: agents = [] } = useProfiles({
    filters: { agentTypes: ["agent"] },
  });
  const { data: llmProxies = [] } = useProfiles({
    filters: { agentTypes: ["llm_proxy"] },
  });
  const { data: environmentsData } = useEnvironments();
  const environments = environmentsData?.environments ?? [];
  const { data: modelsWithApiKeys = [] } = useModelsWithApiKeys();
  const createLimit = useCreateLimit();
  const updateLimit = useUpdateLimit();
  const deleteLimit = useDeleteLimit();

  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const statusFilter = searchParams.get("status") || "all";
  const appliedToFilter = searchParams.get("appliedTo") || "all";
  const modelFilter = searchParams.get("model") || "all";
  const [editingLimit, setEditingLimit] = useState<LimitData | null>(null);
  const [limitToDelete, setLimitToDelete] = useState<LimitData | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [formState, setFormState] =
    useState<LimitFormState>(DEFAULT_FORM_STATE);

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

  const handleCreateOpen = useCallback(() => {
    setEditingLimit(null);
    setFormState(DEFAULT_FORM_STATE);
    setIsDialogOpen(true);
  }, []);

  useEffect(() => {
    setActionButton(
      <PermissionButton
        permissions={{ llmLimit: ["create"] }}
        onClick={handleCreateOpen}
      >
        <Plus className="h-4 w-4" />
        Add Limit
      </PermissionButton>,
    );

    return () => setActionButton(null);
  }, [handleCreateOpen, setActionButton]);

  const handleEditOpen = useCallback(
    (limit: LimitData) => {
      setEditingLimit(limit);
      const models = getLimitModels(limit);
      const isAllModels =
        models.length === 0 && limit.limitType === "token_cost";

      let entityType: LimitFormEntityType = limit.entityType;
      if (limit.entityType === "agent") {
        const isLlmProxy = llmProxies.some(
          (candidate) => candidate.id === limit.entityId,
        );
        if (isLlmProxy) {
          entityType = "llm_proxy";
        }
      }

      setFormState({
        entityType,
        entityId: limit.entityType === "organization" ? "" : limit.entityId,
        limitValue: String(limit.limitValue),
        cleanupInterval:
          limit.cleanupInterval ?? DEFAULT_LIMIT_CLEANUP_INTERVAL,
        models: isAllModels ? [] : models,
        isAllModels,
      });
      setIsDialogOpen(true);
    },
    [llmProxies],
  );

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
      if (limit.entityType === "agent") {
        const agent = agents.find(
          (candidate) => candidate.id === limit.entityId,
        );
        if (agent) {
          return agent.name ?? "Unknown agent";
        }
        const proxy = llmProxies.find(
          (candidate) => candidate.id === limit.entityId,
        );
        return proxy?.name ?? "Unknown LLM proxy";
      }
      if (limit.entityType === "environment") {
        const environment = environments.find(
          (candidate) => candidate.id === limit.entityId,
        );
        return environment?.name ?? "Unknown environment";
      }
      return "Unknown";
    },
    [teams, members, virtualKeys, agents, llmProxies, environments],
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
      if (limit.entityType === "environment") {
        return <Boxes className={iconClassName} />;
      }
      if (
        limit.entityType === "agent" &&
        llmProxies.some((candidate) => candidate.id === limit.entityId)
      ) {
        return <Network className={iconClassName} />;
      }
      return (
        <AgentIcon icon={null} fallbackType="agent" className={iconClassName} />
      );
    },
    [llmProxies],
  );

  const getUsageStatus = useCallback(
    (
      limit: LimitData,
    ): {
      percentage: number;
      status: UsageStatus;
      actualUsage: number;
      actualLimit: number;
    } => {
      const actualUsage = (limit.modelUsage ?? []).reduce(
        (sum, usage) => sum + usage.cost,
        0,
      );
      const actualLimit = limit.limitValue;
      const percentage =
        actualLimit > 0 ? (actualUsage / actualLimit) * 100 : 0;
      if (percentage >= 90) {
        return { percentage, status: "danger", actualUsage, actualLimit };
      }
      if (percentage >= 75) {
        return { percentage, status: "warning", actualUsage, actualLimit };
      }
      return { percentage, status: "safe", actualUsage, actualLimit };
    },
    [],
  );

  const filteredLimits = useMemo(() => {
    return llmLimits.filter((limit) => {
      const usageStatus = getUsageStatus(limit).status;
      const matchesStatus =
        statusFilter === "all" || usageStatus === statusFilter;
      const matchesAppliedTo =
        appliedToFilter === "all" ||
        (appliedToFilter === "agent" &&
          limit.entityType === "agent" &&
          agents.some((candidate) => candidate.id === limit.entityId)) ||
        (appliedToFilter === "llm_proxy" &&
          limit.entityType === "agent" &&
          llmProxies.some((candidate) => candidate.id === limit.entityId)) ||
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

      return matchesStatus && matchesAppliedTo && matchesModel;
    });
  }, [
    appliedToFilter,
    llmLimits,
    modelFilter,
    statusFilter,
    getUsageStatus,
    agents,
    llmProxies,
  ]);

  const columns = useMemo<ColumnDef<LimitData>[]>(
    () => [
      {
        accessorKey: "status",
        header: "Status",
        size: 100,
        minSize: 80,
        cell: ({ row }) => {
          const status = getUsageStatus(row.original).status;
          return (
            <Badge
              variant={
                status === "danger"
                  ? "destructive"
                  : status === "warning"
                    ? "secondary"
                    : "outline"
              }
            >
              {status === "danger"
                ? "Exceeded"
                : status === "warning"
                  ? "Near limit"
                  : "Safe"}
            </Badge>
          );
        },
      },
      {
        accessorKey: "entityId",
        header: "Applied to",
        size: 150,
        minSize: 120,
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2">
            {getEntityIcon(row.original)}
            <span className="truncate">{getEntityLabel(row.original)}</span>
          </div>
        ),
      },
      {
        accessorKey: "model",
        header: "Models",
        size: 250,
        minSize: 180,
        cell: ({ row }) => {
          const models = getLimitModels(row.original);
          const isAllModels =
            models.length === 0 && row.original.limitType === "token_cost";
          const visibleModels = models.slice(0, MAX_VISIBLE_MODEL_BADGES);
          const remainingModels = models.slice(MAX_VISIBLE_MODEL_BADGES);
          return (
            <div className="flex flex-wrap gap-1">
              {isAllModels && (
                <Badge
                  variant="outline"
                  className="text-xs"
                  data-testid="limits-table-models-badge"
                >
                  All models
                </Badge>
              )}
              {!isAllModels &&
                visibleModels.map((model) => (
                  <Badge
                    key={model}
                    variant="outline"
                    className="text-xs"
                    data-testid="limits-table-models-badge"
                  >
                    {model}
                  </Badge>
                ))}
              {remainingModels.length > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="outline"
                      className="cursor-default text-xs"
                      data-testid="limits-table-models-more-badge"
                    >
                      +{remainingModels.length} more
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-80">
                    <div className="space-y-1">
                      {remainingModels.map((model) => (
                        <div key={model}>{model}</div>
                      ))}
                    </div>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          );
        },
      },
      {
        accessorKey: "cleanupInterval",
        header: "Cleanup",
        size: 140,
        minSize: 120,
        cell: ({ row }) => {
          const cleanupInterval =
            (row.original.cleanupInterval as LimitCleanupInterval | null) ??
            DEFAULT_LIMIT_CLEANUP_INTERVAL;
          return (
            <div className="space-y-0.5">
              <div>{CLEANUP_INTERVAL_LABELS[cleanupInterval]}</div>
              <div className="text-xs text-muted-foreground">
                {formatNextLimitReset(
                  row.original.lastCleanup,
                  cleanupInterval,
                )}
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: "usage",
        header: "Usage",
        size: 200,
        minSize: 160,
        cell: ({ row }) => {
          const usage = getUsageStatus(row.original);
          return (
            <div className="w-[180px]">
              <Progress
                value={Math.min(usage.percentage, 100)}
                className={
                  usage.status === "danger"
                    ? "bg-red-100"
                    : usage.status === "warning"
                      ? "bg-orange-100"
                      : undefined
                }
              />
              <p className="mt-1 text-left text-xs text-muted-foreground">
                {`${formatCurrencyWhole(usage.actualUsage)} / ${formatCurrencyWhole(usage.actualLimit)} (${usage.percentage.toFixed(1)}%)`}
              </p>
            </div>
          );
        },
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
                onClick: () => handleEditOpen(row.original),
              },
              {
                icon: <Trash2 className="h-4 w-4" />,
                label: "Delete limit",
                variant: "destructive",
                onClick: () => setLimitToDelete(row.original),
              },
            ]}
          />
        ),
      },
    ],
    [getEntityIcon, getEntityLabel, getUsageStatus, handleEditOpen],
  );

  const hasActiveFilters =
    statusFilter !== "all" ||
    appliedToFilter !== "all" ||
    modelFilter !== "all";
  const shouldShowDefaultUserLimitNotice =
    formState.entityType === "user" && defaultUserLimits.length > 0;
  const limitsDocsUrl = getFrontendDocsUrl(
    DocsPage.PlatformCostsAndLimits,
    "usage-limits",
  );

  async function handleSubmit() {
    const entityType =
      formState.entityType === "llm_proxy" ? "agent" : formState.entityType;
    const body = {
      entityType,
      entityId:
        formState.entityType === "organization"
          ? (organization?.id ?? "")
          : formState.entityId,
      limitType: "token_cost" as const,
      limitValue: Number(formState.limitValue),
      cleanupInterval: formState.cleanupInterval,
      model: formState.isAllModels ? null : formState.models,
    };

    if (editingLimit) {
      const result = await updateLimit.mutateAsync({
        id: editingLimit.id,
        ...body,
      });
      if (result) {
        setIsDialogOpen(false);
        setEditingLimit(null);
      }
      return;
    }

    const result = await createLimit.mutateAsync(body);
    if (result) {
      setIsDialogOpen(false);
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
    <div className="space-y-4">
      {defaultUserLimits.length > 0 && (
        <WithPermissions
          permissions={{ llmLimit: ["read"] }}
          noPermissionHandle="hide"
        >
          <Alert variant="info">
            <AlertDescription className="block">
              A default user limit applies to every user. Custom per-user limits
              override it. Configure it in{" "}
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
      )}

      <div className="flex flex-wrap gap-3">
        <Select
          value={statusFilter}
          onValueChange={(value) =>
            updateQueryParams({ status: value === "all" ? null : value })
          }
        >
          <SelectTrigger className="w-full sm:w-[220px]">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="safe">Safe</SelectItem>
            <SelectItem value="warning">Near limit</SelectItem>
            <SelectItem value="danger">Exceeded</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={appliedToFilter}
          onValueChange={(value) =>
            updateQueryParams({ appliedTo: value === "all" ? null : value })
          }
        >
          <SelectTrigger className="w-full sm:w-[220px]">
            <SelectValue placeholder="All scopes" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All applied to</SelectItem>
            <SelectItem value="organization">Organization</SelectItem>
            <SelectItem value="team">Team</SelectItem>
            <SelectItem value="agent">Agent</SelectItem>
            <SelectItem value="llm_proxy">LLM Proxy</SelectItem>
            <SelectItem value="user">User</SelectItem>
            <SelectItem value="virtual_key">Virtual Key</SelectItem>
            <SelectItem value="environment">Environment</SelectItem>
          </SelectContent>
        </Select>

        <LlmModelSearchableSelect
          value={modelFilter}
          onValueChange={(value) =>
            updateQueryParams({ model: value === "all" ? null : value })
          }
          options={modelOptions}
          placeholder="All models"
          className="sm:max-w-[320px]"
          showPricing={false}
          includeAllOption
          allLabel="All models"
        />
      </div>

      <LoadingWrapper
        isPending={isPending}
        loadingFallback={<LoadingSpinner />}
      >
        <DataTable
          columns={columns}
          data={filteredLimits}
          emptyMessage="No limits configured"
          hasActiveFilters={hasActiveFilters}
          filteredEmptyMessage="No limits match your filters. Try adjusting your search."
          onClearFilters={() => {
            updateQueryParams({ status: null, appliedTo: null, model: null });
          }}
        />
      </LoadingWrapper>

      <FormDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
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

                {formState.entityType === "llm_proxy" && (
                  <SearchableSelect
                    value={formState.entityId}
                    onValueChange={(value) =>
                      setFormState((current) => ({
                        ...current,
                        entityId: value,
                      }))
                    }
                    placeholder="Select LLM proxy"
                    items={llmProxies.map((proxy) => ({
                      value: proxy.id,
                      label: proxy.name,
                      description: proxy.description ?? undefined,
                    }))}
                    className="w-full sm:flex-1"
                  />
                )}

                {formState.entityType === "environment" && (
                  <EnvironmentScopeSelect
                    value={formState.entityId}
                    onValueChange={(value) =>
                      setFormState((current) => ({
                        ...current,
                        entityId: value,
                      }))
                    }
                    environments={environments}
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
          </DialogBody>
          <DialogStickyFooter className="mt-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsDialogOpen(false)}
            >
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
