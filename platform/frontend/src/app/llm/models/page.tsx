"use client";

import {
  isOpenRouterLatestAlias,
  providerRequiresPerUserCredential,
} from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ArrowLeftRight,
  Boxes,
  Brain,
  Eye,
  EyeOff,
  Fingerprint,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  UserRoundCheck,
  Users,
} from "lucide-react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CreateLlmProviderApiKeyDialog } from "@/components/create-llm-provider-api-key-dialog";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import { PROVIDER_CONFIG } from "@/components/llm-provider-api-key-form";
import {
  BestModelBadge,
  EmbeddingModelBadge,
  FreeModelBadge,
  LatestModelBadge,
  PerUserModelBadge,
  UnknownCapabilitiesBadge,
} from "@/components/model-badges";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { BulkActionsScope } from "@/components/ui/bulk-actions-context";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { reportBulkOutcome } from "@/lib/bulk-action";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import {
  type ModelWithApiKeys,
  useBulkUpdateModelVisibility,
  useModelsWithApiKeys,
  useSyncLlmModels,
  useUpdateModel,
} from "@/lib/llm-models.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { formatPricePerMillion } from "@/lib/model-price-format";
import { formatContextLength } from "@/lib/utils";
import { EditModelDialog } from "./_parts/edit-model-dialog";
import {
  canFilterFreeModelsForApiKey,
  filterModelsForPage,
  type ModelsPageModelTypeFilter,
  OBSERVED_MODEL_SOURCE_DESCRIPTION,
  OBSERVED_MODEL_SOURCE_LABEL,
  resolveDisplayContextLength,
  resolveDisplayOutputLength,
} from "./models-page-utils";

export default function ModelsPage() {
  const {
    data: models = [],
    isFetching,
    isLoadingError: isModelsLoadError,
    refetch,
  } = useModelsWithApiKeys({ toastOnError: false });
  const { data: apiKeys = [] } = useLlmProviderApiKeys();
  const syncModelsMutation = useSyncLlmModels();
  const updateModel = useUpdateModel();
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);
  const [isCreateApiKeyDialogOpen, setIsCreateApiKeyDialogOpen] =
    useState(false);
  const [search, setSearch] = useState("");
  const [apiKeyFilter, setApiKeyFilter] = useState<string>("all");
  const [apiKeyFilterOpen, setApiKeyFilterOpen] = useState(false);
  const [modelTypeFilter, setModelTypeFilter] =
    useState<ModelsPageModelTypeFilter>("all");
  const [freeOnly, setFreeOnly] = useState(false);
  const editId = useSearchParams().get("edit");
  const modelFromUrl = useMemo(
    () => models.find((model) => model.id === editId) ?? null,
    [models, editId],
  );
  const {
    entity: editingModel,
    open: openEditDialog,
    close: closeEditDialog,
  } = useDialogUrlParam({ paramName: "edit", entityFromUrl: modelFromUrl });

  const canFilterFreeModels = useMemo(
    () =>
      canFilterFreeModelsForApiKey({ availableApiKeys: apiKeys, apiKeyFilter }),
    [apiKeys, apiKeyFilter],
  );

  useEffect(() => {
    if (!canFilterFreeModels && freeOnly) {
      setFreeOnly(false);
    }
  }, [canFilterFreeModels, freeOnly]);

  const bulkVisibility = useBulkUpdateModelVisibility();

  const filteredModels = useMemo(
    () =>
      filterModelsForPage({
        models,
        search,
        apiKeyFilter,
        modelTypeFilter,
        freeOnly,
        canFilterFreeModels,
      }),
    [
      models,
      search,
      apiKeyFilter,
      modelTypeFilter,
      freeOnly,
      canFilterFreeModels,
    ],
  );

  const handleRefresh = useCallback(async () => {
    setIsRefreshingModels(true);
    try {
      await syncModelsMutation.mutateAsync();
      await refetch();
    } finally {
      setIsRefreshingModels(false);
    }
  }, [syncModelsMutation, refetch]);

  const {
    rowSelection,
    setRowSelection,
    onPageRowIdsChange,
    clearSelection,
    selected: selectedModels,
    selectAllMatching,
  } = useBulkSelection({
    rows: filteredModels,
    getId: (model) => model.id,
    filterSignature: JSON.stringify({
      search,
      apiKeyFilter,
      modelTypeFilter,
    }),
    matchDescription: "match the current filters",
  });

  // Hiding keeps a model out of the pickers without deleting anything, so the
  // bar offers both directions rather than a single toggle whose meaning would
  // depend on a mixed selection.
  const applyVisibility = (ignored: boolean) =>
    bulkVisibility.mutate(
      { models: selectedModels, ignored },
      {
        onSuccess: (outcome) => {
          reportBulkOutcome({
            outcome,
            verb: ignored ? "Hid" : "Showed",
            failureVerb: ignored ? "hide" : "show",
            noun: "model",
          });
          if (outcome.failed.length === 0) clearSelection();
        },
      },
    );

  const refreshModelsButton = (
    <Button
      variant="outline"
      size="sm"
      onClick={handleRefresh}
      disabled={isRefreshingModels}
    >
      <RefreshCw
        className={`h-4 w-4 ${isRefreshingModels ? "animate-spin" : ""}`}
      />
      {isRefreshingModels ? "Refreshing..." : "Refresh Models"}
    </Button>
  );

  const columns: ColumnDef<ModelWithApiKeys>[] = useMemo(
    () => [
      createSelectColumn<ModelWithApiKeys>({
        rowLabel: (model) => `Select ${model.modelId}`,
        allLabel: "Select all models on this page",
      }),
      {
        id: "providerIcon",
        size: 40,
        header: "",
        cell: ({ row }) => {
          const config = PROVIDER_CONFIG[row.original.provider];
          if (!config) return null;
          return (
            <div className="flex items-center justify-center">
              <Image
                src={config.icon}
                alt={config.name}
                width={20}
                height={20}
                className="rounded dark:invert"
              />
            </div>
          );
        },
      },
      {
        accessorKey: "modelId",
        size: 280,
        header: "Model ID",
        cell: ({ row }) => {
          const { modelId, provider, isFree } = row.original;
          const isLatestAlias = isOpenRouterLatestAlias(provider, modelId);
          return (
            <div className="min-w-0 space-y-2">
              <span className="font-mono text-sm">{modelId}</span>
              <div className="mt-0.5 flex flex-wrap items-center gap-2">
                {isFree && <FreeModelBadge />}
                {isLatestAlias && <LatestModelBadge />}
                {row.original.isBest && <BestModelBadge />}
                {providerRequiresPerUserCredential(provider) && (
                  <PerUserModelBadge />
                )}
                {row.original.embeddingDimensions !== null && (
                  <EmbeddingModelBadge />
                )}
                {row.original.teams.length > 0 && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="outline" className="text-xs gap-1">
                          <Users className="h-3 w-3 shrink-0" />
                          <span>
                            {row.original.teams.length === 1
                              ? "1 team"
                              : `${row.original.teams.length} teams`}
                          </span>
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        <p>
                          Limited to:{" "}
                          {row.original.teams
                            .map((team) => team.name)
                            .join(", ")}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
                {row.original.users.length > 0 && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="outline" className="text-xs gap-1">
                          <UserRoundCheck className="h-3 w-3 shrink-0" />
                          <span>
                            {row.original.users.length === 1
                              ? "1 person"
                              : `${row.original.users.length} people`}
                          </span>
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        <p>
                          Limited to:{" "}
                          {row.original.users
                            .map((user) => user.name)
                            .join(", ")}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: "apiKeys",
        header: "Source",
        cell: ({ row }) => {
          const apiKeys = row.original.apiKeys;
          if (apiKeys.length === 0) {
            if (row.original.discoveredViaLlmProxy) {
              return (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      {/* Bounded like the API-key badges beside it: this
                          label is the longest thing the column ever renders,
                          and unbounded it spilled over the next column. */}
                      <Badge
                        variant="secondary"
                        className="text-xs gap-1 max-w-full"
                      >
                        <ArrowLeftRight className="h-3 w-3 shrink-0" />
                        <span className="truncate">
                          {OBSERVED_MODEL_SOURCE_LABEL}
                        </span>
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      <p>{OBSERVED_MODEL_SOURCE_DESCRIPTION}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              );
            }
            return <span className="text-sm text-muted-foreground">-</span>;
          }
          return (
            <div className="flex flex-wrap gap-1">
              {apiKeys.map((apiKey) => (
                <Badge
                  key={apiKey.id}
                  variant={apiKey.isSystem ? "secondary" : "outline"}
                  className="text-xs gap-1 max-w-full"
                >
                  {apiKey.isSystem && <Server className="h-3 w-3 shrink-0" />}
                  <span className="truncate">{apiKey.name}</span>
                </Badge>
              ))}
            </div>
          );
        },
      },
      {
        id: "pricingInput",
        size: 104,
        header: "$/M Input",
        cell: ({ row }) => {
          const price = row.original.pricePerMillionInput;
          if (hasUnknownCapabilities(row.original)) return null;
          return price ? (
            <span className="text-sm font-mono">
              ${formatPricePerMillion(price)}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">-</span>
          );
        },
      },
      {
        id: "pricingOutput",
        size: 104,
        header: "$/M Output",
        cell: ({ row }) => {
          const price = row.original.pricePerMillionOutput;
          if (hasUnknownCapabilities(row.original)) return null;
          return price ? (
            <span className="text-sm font-mono">
              ${formatPricePerMillion(price)}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">-</span>
          );
        },
      },
      {
        id: "pricingCache",
        size: 132,
        header: "$/M Cache R/W",
        cell: ({ row }) => {
          const { pricePerMillionCacheRead, pricePerMillionCacheWrite } =
            row.original;
          if (hasUnknownCapabilities(row.original)) return null;
          if (
            pricePerMillionCacheRead === null ||
            pricePerMillionCacheWrite === null
          ) {
            return <span className="text-sm text-muted-foreground">-</span>;
          }
          return (
            <span className="text-sm font-mono">
              {`$${formatPricePerMillion(pricePerMillionCacheRead)} / $${formatPricePerMillion(pricePerMillionCacheWrite)}`}
            </span>
          );
        },
      },
      {
        id: "contextLength",
        // Sorting must follow what the cell shows, not the architectural column.
        accessorFn: (row) => resolveDisplayContextLength(row).display,
        size: 100,
        header: "Context",
        cell: ({ row }) => {
          if (hasUnknownCapabilities(row.original)) {
            return <UnknownCapabilitiesBadge />;
          }
          const { display, architectural, isCapped, isCustom } =
            resolveDisplayContextLength(row.original);
          if (isCapped) {
            return (
              <AnnotatedTokenLimit value={display}>
                This model supports {formatContextLength(architectural)} tokens,
                but is capped at {formatContextLength(display)} by its Ollama
                Modelfile or a configured num_ctx.
              </AnnotatedTokenLimit>
            );
          }
          if (isCustom) {
            return (
              <AnnotatedTokenLimit value={display}>
                Set manually, overriding whatever the provider reports for this
                model.
              </AnnotatedTokenLimit>
            );
          }
          return (
            <span className="text-sm">{formatContextLength(display)}</span>
          );
        },
      },
      {
        id: "outputLength",
        // Sorting follows the cell, which prefers the admin override.
        accessorFn: (row) => resolveDisplayOutputLength(row).display,
        size: 100,
        header: "Max output",
        cell: ({ row }) => {
          if (hasUnknownCapabilities(row.original)) return null;
          const { display, isCustom } = resolveDisplayOutputLength(
            row.original,
          );
          if (!isCustom) {
            return (
              <span className="text-sm">{formatContextLength(display)}</span>
            );
          }
          return (
            <AnnotatedTokenLimit value={display}>
              Set manually, overriding whatever the provider reports for this
              model.
            </AnnotatedTokenLimit>
          );
        },
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <TableRowActions
            itemName={row.original.modelId}
            actions={[
              {
                icon: row.original.ignored ? (
                  <Eye className="h-4 w-4" />
                ) : (
                  <EyeOff className="h-4 w-4" />
                ),
                label: row.original.ignored ? "Show model" : "Hide model",
                onClick: () =>
                  updateModel.mutate({
                    id: row.original.id,
                    ignored: !row.original.ignored,
                  }),
                disabled: updateModel.isPending,
              },
              {
                icon: <Pencil className="h-4 w-4" />,
                label: "Edit",
                onClick: () => openEditDialog(row.original),
              },
            ]}
          />
        ),
      },
    ],
    [updateModel, openEditDialog],
  );

  if (isModelsLoadError) {
    return (
      <PageLayout
        title="Models"
        description='Models available from your configured providers. Use "Refresh Models" to re-fetch models and capabilities from providers.'
        actionButton={refreshModelsButton}
      >
        <QueryLoadError
          title="Couldn't load your models"
          onRetry={() => refetch()}
        />
      </PageLayout>
    );
  }

  return (
    <PageLayout
      title="Models"
      description='Models available from your configured providers. Use "Refresh Models" to re-fetch models and capabilities from providers.'
      actionButton={refreshModelsButton}
    >
      <BulkActionsScope>
        {models.length > 0 && (
          <CollectionFilters>
            <FilterBar leading>
              <SearchInput
                objectNamePlural="models"
                searchFields={["model ID"]}
                value={search}
                onSearchChange={setSearch}
                syncQueryParams={false}
                className={filterSearchClass}
              />
              <LlmProviderApiKeyDropdown
                availableKeys={apiKeys}
                selectedApiKeyId={apiKeyFilter === "all" ? null : apiKeyFilter}
                open={apiKeyFilterOpen}
                onOpenChange={setApiKeyFilterOpen}
                onSelectKey={(value) => {
                  setApiKeyFilter(value);
                  setApiKeyFilterOpen(false);
                }}
                triggerVariant="select"
                triggerClassName={filterControlClass({
                  active: apiKeyFilter !== "all",
                })}
                popoverClassName="w-[min(20rem,calc(100vw-2rem))]"
                allOptionLabel="All provider API keys"
                allOptionSelected={apiKeyFilter === "all"}
                onSelectAllOption={() => {
                  setApiKeyFilter("all");
                  setApiKeyFilterOpen(false);
                }}
              />
              <FilterSelect
                value={modelTypeFilter}
                onValueChange={(v) =>
                  setModelTypeFilter(v as "all" | "chat" | "embedding")
                }
                placeholder="Model type"
                items={[
                  {
                    value: "all",
                    label: "All models",
                    content: (
                      <span className="flex items-center gap-2">
                        <Boxes className="h-4 w-4 text-muted-foreground" />
                        <span>All models</span>
                      </span>
                    ),
                    selectedContent: (
                      <span className="flex items-center gap-2">
                        <Boxes className="h-4 w-4 text-muted-foreground" />
                        <span>All models</span>
                      </span>
                    ),
                  },
                  {
                    value: "chat",
                    label: "Chat / generation",
                    content: (
                      <span className="flex items-center gap-2">
                        <Brain className="h-4 w-4 text-muted-foreground" />
                        <span>Chat / generation</span>
                      </span>
                    ),
                    selectedContent: (
                      <span className="flex items-center gap-2">
                        <Brain className="h-4 w-4 text-muted-foreground" />
                        <span>Chat / generation</span>
                      </span>
                    ),
                  },
                  {
                    value: "embedding",
                    label: "Embedding",
                    content: (
                      <span className="flex items-center gap-2">
                        <Fingerprint className="h-4 w-4 text-muted-foreground" />
                        <span>Embedding</span>
                      </span>
                    ),
                    selectedContent: (
                      <span className="flex items-center gap-2">
                        <Fingerprint className="h-4 w-4 text-muted-foreground" />
                        <span>Embedding</span>
                      </span>
                    ),
                  },
                ]}
              />
              {canFilterFreeModels && (
                <div className="flex items-center gap-2">
                  <Switch
                    id="models-free-only"
                    checked={freeOnly}
                    onCheckedChange={setFreeOnly}
                  />
                  <Label
                    htmlFor="models-free-only"
                    className="text-sm text-muted-foreground"
                  >
                    Free only
                  </Label>
                </div>
              )}
            </FilterBar>
          </CollectionFilters>
        )}
        <BulkActions
          count={selectedModels.length}
          noun="model"
          onClear={clearSelection}
          selectAllMatching={selectAllMatching}
          busy={bulkVisibility.isPending}
        >
          <PermissionButton
            permissions={{ llmModel: ["update"] }}
            variant="outline"
            size="sm"
            onClick={() => applyVisibility(false)}
          >
            <Eye className="h-4 w-4" />
            <span>Show</span>
          </PermissionButton>
          <PermissionButton
            permissions={{ llmModel: ["update"] }}
            variant="outline"
            size="sm"
            onClick={() => applyVisibility(true)}
          >
            <EyeOff className="h-4 w-4" />
            <span>Hide</span>
          </PermissionButton>
        </BulkActions>

        <DataTable
          columns={columns}
          data={filteredModels}
          getRowId={(row) => row.id}
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
          onPageRowIdsChange={onPageRowIdsChange}
          getRowClassName={(row) =>
            row.ignored ? "opacity-60 [&_td]:text-muted-foreground" : undefined
          }
          hideSelectedCount
          isLoading={isFetching}
          hasActiveFilters={Boolean(
            search ||
              apiKeyFilter !== "all" ||
              modelTypeFilter !== "all" ||
              (canFilterFreeModels && freeOnly),
          )}
          filteredEmptyMessage="No models match your filters"
          onClearFilters={() => {
            setSearch("");
            setApiKeyFilter("all");
            setModelTypeFilter("all");
            setFreeOnly(false);
          }}
          emptyIcon={Boxes}
          emptyMessage={
            apiKeys.length === 0 ? "No models available" : "No models found"
          }
          emptyDescription={
            apiKeys.length === 0
              ? "Add an API key to see available models."
              : undefined
          }
          emptyAction={
            apiKeys.length === 0 ? (
              <Button onClick={() => setIsCreateApiKeyDialogOpen(true)}>
                <Plus className="h-4 w-4" />
                <span>Add API Key</span>
              </Button>
            ) : undefined
          }
        />
      </BulkActionsScope>

      <CreateLlmProviderApiKeyDialog
        open={isCreateApiKeyDialogOpen}
        onOpenChange={setIsCreateApiKeyDialogOpen}
        title="Add API Key"
        description="Add a new LLM provider API key to load its available models."
      />

      {editingModel && (
        <EditModelDialog
          model={editingModel}
          open={!!editingModel}
          onOpenChange={(open) => {
            if (!open) closeEditDialog();
          }}
        />
      )}
    </PageLayout>
  );
}

// --- Internal helpers ---

/**
 * A token-limit table cell whose number needs a footnote — an Ollama-capped
 * window, or a value an admin set because the provider reports none. Dotted
 * underline marks it as explainable rather than just rendering an unexplained
 * number the provider never published.
 */
function AnnotatedTokenLimit({
  value,
  children,
}: {
  value: number | null;
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-sm underline decoration-dotted underline-offset-4">
            {formatContextLength(value)}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p>{children}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function hasUnknownCapabilities(model: ModelWithApiKeys): boolean {
  const hasInputModalities =
    model.inputModalities && model.inputModalities.length > 0;
  const hasOutputModalities =
    model.outputModalities && model.outputModalities.length > 0;
  const hasToolCalling = model.supportsToolCalling !== null;
  // Effective as well as architectural: a freshly pulled Ollama model is absent
  // from the public catalog (`contextLength` null) but still reports the window
  // it actually runs with. Keying on the architectural value alone hid that
  // number behind an "unknown capabilities" badge — the one figure the chat
  // context ring is enforcing.
  const hasContextLength =
    model.contextLength !== null || model.effectiveContextLength !== null;
  // Including the admin override: setting only the output limit on an
  // otherwise-blank row left this badge up, hiding the number just entered.
  const hasOutputLength = resolveDisplayOutputLength(model).display !== null;
  const hasPricing =
    model.pricePerMillionInput !== null || model.pricePerMillionOutput !== null;
  return (
    !hasInputModalities &&
    !hasOutputModalities &&
    !hasToolCalling &&
    !hasContextLength &&
    !hasOutputLength &&
    !hasPricing
  );
}
