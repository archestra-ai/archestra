"use client";

import {
  type archestraApiTypes,
  INPUT_MODALITY_OPTIONS,
  isOpenRouterLatestAlias,
  type ModelInputModality,
  type ModelOutputModality,
  OUTPUT_MODALITY_OPTIONS,
  providerRequiresPerUserCredential,
  SUPPORTED_EMBEDDING_DIMENSIONS,
} from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  AlertCircle,
  ArrowLeftRight,
  Boxes,
  Brain,
  Eye,
  EyeOff,
  Fingerprint,
  Pencil,
  RefreshCw,
  RotateCcw,
  Server,
  X,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
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
import { StandardFormDialog } from "@/components/standard-dialog";
import { TableRowActions } from "@/components/table-row-actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  type ModelWithApiKeys,
  useModelsWithApiKeys,
  useSyncLlmModels,
  useUpdateModel,
} from "@/lib/llm-models.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { formatContextLength } from "@/lib/utils";
import { MODEL_NAV_TABS } from "../model-nav-tabs";
import {
  canFilterFreeModelsForApiKey,
  filterModelsForPage,
  type ModelsPageModelTypeFilter,
  OBSERVED_MODEL_SOURCE_DESCRIPTION,
  OBSERVED_MODEL_SOURCE_LABEL,
} from "./models-page-utils";

export default function ModelsPage() {
  const {
    data: models = [],
    isPending,
    isLoadingError: isModelsLoadError,
    refetch,
  } = useModelsWithApiKeys({ toastOnError: false });
  const { data: apiKeys = [] } = useLlmProviderApiKeys();
  const syncModelsMutation = useSyncLlmModels();
  const updateModel = useUpdateModel();
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);
  const [search, setSearch] = useState("");
  const [apiKeyFilter, setApiKeyFilter] = useState<string>("all");
  const [apiKeyFilterOpen, setApiKeyFilterOpen] = useState(false);
  const [modelTypeFilter, setModelTypeFilter] =
    useState<ModelsPageModelTypeFilter>("all");
  const [freeOnly, setFreeOnly] = useState(false);
  const [editingModel, setEditingModel] = useState<ModelWithApiKeys | null>(
    null,
  );

  const availableApiKeys = useMemo(() => {
    const keyMap = new Map<
      string,
      { name: string; provider: keyof typeof PROVIDER_CONFIG }
    >();
    for (const model of models) {
      for (const key of model.apiKeys) {
        keyMap.set(key.id, {
          name: key.name,
          provider: key.provider as keyof typeof PROVIDER_CONFIG,
        });
      }
    }
    return Array.from(keyMap.entries()).sort((a, b) =>
      a[1].name.localeCompare(b[1].name),
    );
  }, [models]);

  const canFilterFreeModels = useMemo(
    () => canFilterFreeModelsForApiKey({ availableApiKeys, apiKeyFilter }),
    [availableApiKeys, apiKeyFilter],
  );

  useEffect(() => {
    if (!canFilterFreeModels && freeOnly) {
      setFreeOnly(false);
    }
  }, [canFilterFreeModels, freeOnly]);

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
                      <Badge variant="secondary" className="text-xs gap-1">
                        <ArrowLeftRight className="h-3 w-3 shrink-0" />
                        <span>{OBSERVED_MODEL_SOURCE_LABEL}</span>
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
            <span className="text-sm font-mono">${price}</span>
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
            <span className="text-sm font-mono">${price}</span>
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
              ${pricePerMillionCacheRead} / ${pricePerMillionCacheWrite}
            </span>
          );
        },
      },
      {
        accessorKey: "contextLength",
        size: 100,
        header: "Context",
        cell: ({ row }) => {
          if (hasUnknownCapabilities(row.original)) {
            return <UnknownCapabilitiesBadge />;
          }
          return (
            <span className="text-sm">
              {formatContextLength(row.original.contextLength ?? null)}
            </span>
          );
        },
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <TableRowActions
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
                onClick: () => setEditingModel(row.original),
              },
            ]}
          />
        ),
      },
    ],
    [updateModel],
  );

  if (isModelsLoadError) {
    return (
      <PageLayout
        title="Models"
        description='Models available from your configured providers. Use "Refresh Models" to re-fetch models and capabilities from providers.'
        tabs={MODEL_NAV_TABS}
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
      tabs={MODEL_NAV_TABS}
      actionButton={refreshModelsButton}
    >
      <div className="space-y-4">
        {models.length > 0 && (
          <div className="flex flex-wrap gap-4">
            <SearchInput
              objectNamePlural="models"
              searchFields={["model ID"]}
              value={search}
              onSearchChange={setSearch}
              syncQueryParams={false}
            />
            <LlmProviderApiKeyDropdown
              availableKeys={availableApiKeys.flatMap(
                ([id, { name, provider }]) => {
                  const config = PROVIDER_CONFIG[provider];
                  if (!config) return [];
                  return [
                    {
                      id,
                      name,
                      provider,
                    },
                  ];
                },
              )}
              selectedApiKeyId={apiKeyFilter === "all" ? null : apiKeyFilter}
              open={apiKeyFilterOpen}
              onOpenChange={setApiKeyFilterOpen}
              onSelectKey={(value) => {
                setApiKeyFilter(value);
                setApiKeyFilterOpen(false);
              }}
              triggerVariant="select"
              triggerClassName="w-full sm:w-[280px] h-9 text-sm"
              popoverClassName="w-[var(--radix-popover-trigger-width)]"
              allOptionLabel="All provider API keys"
              allOptionSelected={apiKeyFilter === "all"}
              onSelectAllOption={() => {
                setApiKeyFilter("all");
                setApiKeyFilterOpen(false);
              }}
            />
            <SearchableSelect
              value={modelTypeFilter}
              onValueChange={(v) =>
                setModelTypeFilter(v as "all" | "chat" | "embedding")
              }
              placeholder="Model type"
              className="w-full sm:w-[200px]"
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
          </div>
        )}
        <DataTable
          columns={columns}
          data={filteredModels}
          getRowId={(row) => row.id}
          getRowClassName={(row) =>
            row.ignored ? "opacity-60 [&_td]:text-muted-foreground" : undefined
          }
          hideSelectedCount
          isLoading={isPending}
          hasActiveFilters={Boolean(
            search ||
              apiKeyFilter !== "all" ||
              modelTypeFilter !== "all" ||
              (canFilterFreeModels && freeOnly),
          )}
          filteredEmptyMessage="No models match your filters. Try adjusting your search."
          onClearFilters={() => {
            setSearch("");
            setApiKeyFilter("all");
            setModelTypeFilter("all");
            setFreeOnly(false);
          }}
          emptyMessage={
            apiKeys.length === 0
              ? "No models available. Add an API key to see available models."
              : "No models found"
          }
        />
      </div>

      {editingModel && (
        <EditModelDialog
          model={editingModel}
          open={!!editingModel}
          onOpenChange={(open) => {
            if (!open) setEditingModel(null);
          }}
        />
      )}
    </PageLayout>
  );
}

// --- Edit Model Dialog ---

type UpdateModelBody = archestraApiTypes.UpdateModelData["body"];
type UpdateModelEmbeddingDimensions = NonNullable<
  UpdateModelBody["embeddingDimensions"]
>;

const EMBEDDING_DIMENSION_MAP = {
  "384": 384,
  "768": 768,
  "1024": 1024,
  "1536": 1536,
  "3072": 3072,
} satisfies Record<string, UpdateModelEmbeddingDimensions>;
const NOT_EMBEDDING_MODEL_VALUE = "none";

type EditModelEmbeddingDimensionsValue =
  | ""
  | keyof typeof EMBEDDING_DIMENSION_MAP;

interface EditModelFormValues {
  customPricePerMillionInput: string;
  customPricePerMillionOutput: string;
  customPricePerMillionCacheRead: string;
  customPricePerMillionCacheWrite: string;
  ignored: boolean;
  embeddingDimensions: EditModelEmbeddingDimensionsValue;
  inputModalities: string[];
  outputModalities: string[];
}

function EditModelDialog({
  model,
  open,
  onOpenChange,
}: {
  model: ModelWithApiKeys;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const appName = useAppName();
  const [inputModalityToAdd, setInputModalityToAdd] = useState("");
  const [outputModalityToAdd, setOutputModalityToAdd] = useState("");
  const updateModel = useUpdateModel();
  const providerConfig = PROVIDER_CONFIG[model.provider];
  const fallbackPricing = getFallbackPricing(model);
  // The model's provider supports prompt caching when the backend resolved a
  // cache price for it (synced, custom, or multiplier-derived).
  const supportsCachePricing = model.cachePriceSource !== null;
  const nonNegativePriceRule = {
    validate: (v: string) => {
      if (!v) return true;
      const n = parseFloat(v);
      if (Number.isNaN(n) || n < 0) return "Must be a non-negative number";
      return true;
    },
  };
  const form = useForm<EditModelFormValues>({
    defaultValues: getDefaults(model),
  });
  const selectedEmbeddingDimensions = form.watch("embeddingDimensions");

  useEffect(() => {
    if (open) {
      form.reset(getDefaults(model));
    }
  }, [open, model, form]);

  const handleSubmit = async (values: EditModelFormValues) => {
    const inputPrice = values.customPricePerMillionInput.trim() || null;
    const outputPrice = values.customPricePerMillionOutput.trim() || null;
    const cacheReadPrice = values.customPricePerMillionCacheRead.trim() || null;
    const cacheWritePrice =
      values.customPricePerMillionCacheWrite.trim() || null;
    const embeddingDimensions = getEmbeddingDimensionsValue(
      values.embeddingDimensions,
    );

    const result = await updateModel.mutateAsync({
      id: model.id,
      customPricePerMillionInput: inputPrice,
      customPricePerMillionOutput: outputPrice,
      customPricePerMillionCacheRead: cacheReadPrice,
      customPricePerMillionCacheWrite: cacheWritePrice,
      ignored: values.ignored,
      embeddingDimensions,
      inputModalities: values.inputModalities as ModelInputModality[],
      outputModalities: values.outputModalities as ModelOutputModality[],
    });
    if (result) {
      onOpenChange(false);
    }
  };

  const handleResetPricing = () => {
    form.setValue("customPricePerMillionInput", "");
    form.setValue("customPricePerMillionOutput", "");
    form.setValue("customPricePerMillionCacheRead", "");
    form.setValue("customPricePerMillionCacheWrite", "");
  };

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit Model"
      description="Update pricing and modality settings for this model."
      size="large"
      onSubmit={form.handleSubmit(handleSubmit)}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={updateModel.isPending}>
            {updateModel.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </>
      }
    >
      <Form {...form}>
        <div className="space-y-4">
          {/* Read-only: Provider */}
          <div className="space-y-1">
            <span className="text-sm font-medium">Provider</span>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {providerConfig && (
                <Image
                  src={providerConfig.icon}
                  alt={providerConfig.name}
                  width={20}
                  height={20}
                  className="rounded dark:invert"
                />
              )}
              <span>{providerConfig?.name ?? model.provider}</span>
            </div>
          </div>

          {/* Read-only: Model ID */}
          <div className="space-y-1">
            <span className="text-sm font-medium">Model ID</span>
            <p className="text-sm font-mono text-muted-foreground">
              {model.modelId}
            </p>
          </div>

          {/* Pricing */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                Custom Pricing ($/M tokens)
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={handleResetPricing}
              >
                <RotateCcw className="h-3 w-3" />
                Reset
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="customPricePerMillionInput"
                rules={nonNegativePriceRule}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Input</FormLabel>
                    <FormControl>
                      <Input placeholder={fallbackPricing.input} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="customPricePerMillionOutput"
                rules={nonNegativePriceRule}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Output</FormLabel>
                    <FormControl>
                      <Input placeholder={fallbackPricing.output} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            {model.priceSource === "default" && (
              <p className="text-xs text-muted-foreground">
                Input/output prices are estimated — set a custom price for
                accurate cost tracking.
              </p>
            )}
            {supportsCachePricing && (
              <div className="space-y-2 pt-1">
                <span className="text-sm font-medium">
                  Cache Pricing ($/M tokens)
                </span>
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="customPricePerMillionCacheRead"
                    rules={nonNegativePriceRule}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Cache read</FormLabel>
                        <FormControl>
                          <Input
                            placeholder={fallbackPricing.cacheRead}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="customPricePerMillionCacheWrite"
                    rules={nonNegativePriceRule}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Cache write</FormLabel>
                        <FormControl>
                          <Input
                            placeholder={fallbackPricing.cacheWrite}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                {model.cachePriceSource === "derived_multiplier" && (
                  <p className="text-xs text-muted-foreground">
                    Cache prices are estimated from the input price. Set a
                    custom cache price to override.
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <span className="text-sm font-medium">Modalities</span>
              <p className="text-sm text-muted-foreground">
                These settings describe what the model can accept as input and
                what it can produce as output.
              </p>
            </div>
            <Alert variant="info">
              <AlertCircle />
              <AlertTitle>How {appName} chat support is determined</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    Text input means the model can accept normal chat prompts.
                    In {appName} chat, it also enables text-based uploads such
                    as <code>.txt</code> and <code>.csv</code>, which are passed
                    to the model as text content. Text output means the model
                    can return standard chat responses.
                  </li>
                  <li>
                    In {appName} chat, a model appears as a standard chat model
                    when it supports both text input and text output and is not
                    hidden.
                  </li>
                  <li>
                    Image, audio, video, and PDF input modalities control
                    whether chat file upload is enabled for the model and which
                    uploaded file types are accepted.
                  </li>
                  <li>
                    Output modalities describe the response formats the model
                    can generate, but they do not enable file uploads by
                    themselves.
                  </li>
                </ul>
              </AlertDescription>
            </Alert>

            <div className="grid items-start gap-3 md:grid-cols-2">
              <FormField
                control={form.control}
                name="inputModalities"
                rules={{
                  validate: (v) =>
                    v.length > 0 || "At least one input modality is required",
                }}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Input</FormLabel>
                    <FormControl>
                      <ModalitySelectField
                        options={INPUT_MODALITY_OPTIONS}
                        value={field.value}
                        onValueChange={field.onChange}
                        selectValue={inputModalityToAdd}
                        onSelectValueChange={setInputModalityToAdd}
                        placeholder="Add input modality..."
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="outputModalities"
                rules={{
                  validate: (v) =>
                    shouldRequireOutputModalities(selectedEmbeddingDimensions)
                      ? v.length > 0 ||
                        "At least one output modality is required"
                      : true,
                }}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Output</FormLabel>
                    <FormControl>
                      <ModalitySelectField
                        options={OUTPUT_MODALITY_OPTIONS}
                        value={field.value}
                        onValueChange={field.onChange}
                        selectValue={outputModalityToAdd}
                        onSelectValueChange={setOutputModalityToAdd}
                        placeholder="Add output modality..."
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </div>

          <Separator />

          <div className="space-y-3">
            <div className="space-y-1">
              <span className="text-sm font-medium">Embedding</span>
              <p className="text-sm text-muted-foreground">
                Set embedding dimensions to make this model available for
                knowledge base embeddings. Leave it unset for chat-only models.
                This must match the vector size the provider returns or the size
                you intentionally truncate to.
              </p>
            </div>

            <Alert variant="info">
              <AlertCircle />
              <AlertTitle>How embedding input modalities are used</AlertTitle>
              <AlertDescription>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    Input modalities control which source content types can be
                    sent to this model when {appName} generates embeddings for
                    knowledge connectors and uploaded files.
                  </li>
                  <li>
                    Text input enables text-based content such as documents,
                    pages, and extracted file text.
                  </li>
                  <li>
                    Image input enables image files to be considered for
                    embedding when the connector and model both support it.
                  </li>
                  <li>
                    Output modalities are not required for embedding-only
                    models.
                  </li>
                </ul>
              </AlertDescription>
            </Alert>

            <FormField
              control={form.control}
              name="embeddingDimensions"
              render={({ field }) => (
                <FormItem>
                  <Select
                    value={field.value || NOT_EMBEDDING_MODEL_VALUE}
                    onValueChange={(value) =>
                      field.onChange(
                        value === NOT_EMBEDDING_MODEL_VALUE ? "" : value,
                      )
                    }
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Not an embedding model" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NOT_EMBEDDING_MODEL_VALUE}>
                        Not an embedding model
                      </SelectItem>
                      {SUPPORTED_EMBEDDING_DIMENSIONS.map((dimension) => (
                        <SelectItem
                          key={dimension}
                          value={dimension.toString()}
                        >
                          {dimension}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <Separator />

          <FormField
            control={form.control}
            name="ignored"
            render={({ field }) => (
              <FormItem className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-1">
                    <FormLabel>Hide this model</FormLabel>
                    <p className="text-sm text-muted-foreground">
                      Hidden models remain synced and editable in this catalog,
                      but they are excluded anywhere {appName} offers model
                      selection.
                    </p>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </div>
                <FormMessage />
              </FormItem>
            )}
          />

          {model.provider === "ollama" &&
            model.defaultParameters &&
            Object.keys(model.defaultParameters).length > 0 && (
              <>
                <Separator />
                <div className="space-y-2">
                  <span className="text-sm font-medium">
                    Default parameters
                  </span>
                  <p className="text-sm text-muted-foreground">
                    Defaults reported by Ollama for this model, shown for
                    reference. {appName} does not apply them to requests.
                  </p>
                  <dl className="divide-y rounded-lg border text-sm">
                    {Object.entries(model.defaultParameters).map(
                      ([key, value]) => (
                        <div
                          key={key}
                          className="flex items-center justify-between gap-4 px-3 py-2"
                        >
                          <dt className="font-mono text-muted-foreground">
                            {key}
                          </dt>
                          <dd className="font-mono">
                            {Array.isArray(value)
                              ? value.join(", ")
                              : String(value)}
                          </dd>
                        </div>
                      ),
                    )}
                  </dl>
                </div>
              </>
            )}
        </div>
      </Form>
    </StandardFormDialog>
  );
}

// --- Internal helpers ---

function ModalitySelectField<T extends string>(params: {
  options: Array<{ value: T; label: string; description: string }>;
  value: string[];
  onValueChange: (value: string[]) => void;
  selectValue: string;
  onSelectValueChange: (value: string) => void;
  placeholder: string;
}) {
  const {
    options,
    value,
    onValueChange,
    selectValue,
    onSelectValueChange,
    placeholder,
  } = params;

  return (
    <div className="space-y-2">
      <SearchableSelect
        value={selectValue}
        onValueChange={(nextValue) => {
          onSelectValueChange("");
          if (value.includes(nextValue)) {
            return;
          }

          onValueChange([...value, nextValue]);
        }}
        placeholder={placeholder}
        searchPlaceholder="Search modalities..."
        className="w-full"
        items={options.map((option) => ({
          value: option.value,
          label: option.label,
          content: (
            <span className="block min-w-0">
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {option.description}
              </span>
            </span>
          ),
          checked: value.includes(option.value),
          disabled: value.includes(option.value),
        }))}
      />
      <div className="flex flex-wrap gap-1">
        {value.map((selectedValue) => {
          const option = options.find((item) => item.value === selectedValue);
          if (!option) {
            return null;
          }

          return (
            <Badge
              key={option.value}
              variant="secondary"
              className="gap-1 pr-1"
            >
              {option.label}
              <Button
                type="button"
                aria-label="Remove option"
                variant="ghost"
                size="icon"
                className="h-4 w-4"
                onClick={() =>
                  onValueChange(value.filter((item) => item !== option.value))
                }
              >
                <X className="h-3 w-3" />
              </Button>
            </Badge>
          );
        })}
      </div>
    </div>
  );
}

function hasUnknownCapabilities(model: ModelWithApiKeys): boolean {
  const hasInputModalities =
    model.inputModalities && model.inputModalities.length > 0;
  const hasOutputModalities =
    model.outputModalities && model.outputModalities.length > 0;
  const hasToolCalling = model.supportsToolCalling !== null;
  const hasContextLength = model.contextLength !== null;
  const hasPricing =
    model.pricePerMillionInput !== null || model.pricePerMillionOutput !== null;
  return (
    !hasInputModalities &&
    !hasOutputModalities &&
    !hasToolCalling &&
    !hasContextLength &&
    !hasPricing
  );
}

/**
 * Placeholder prices shown in the custom-price inputs: the backend's resolved
 * effective price (synced or estimated) for input/output, and the resolved
 * cache prices (null when the model's provider has no cache pricing). The
 * effective price equals the custom override when one is set, but in that case
 * the input is non-empty so the placeholder is not shown.
 */
function getFallbackPricing(model: ModelWithApiKeys): {
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
} {
  return {
    input: model.pricePerMillionInput ?? "",
    output: model.pricePerMillionOutput ?? "",
    cacheRead: model.pricePerMillionCacheRead ?? "",
    cacheWrite: model.pricePerMillionCacheWrite ?? "",
  };
}

function getDefaults(model: ModelWithApiKeys): EditModelFormValues {
  return {
    customPricePerMillionInput: model.customPricePerMillionInput ?? "",
    customPricePerMillionOutput: model.customPricePerMillionOutput ?? "",
    customPricePerMillionCacheRead: model.customPricePerMillionCacheRead ?? "",
    customPricePerMillionCacheWrite:
      model.customPricePerMillionCacheWrite ?? "",
    ignored: model.ignored,
    embeddingDimensions: model.embeddingDimensions
      ? getEmbeddingDimensionsString(model.embeddingDimensions)
      : "",
    inputModalities: model.inputModalities ?? [],
    outputModalities: model.outputModalities ?? [],
  };
}

function getEmbeddingDimensionsString(
  value: UpdateModelEmbeddingDimensions,
): EditModelEmbeddingDimensionsValue {
  if (value === 384) return "384";
  if (value === 768) return "768";
  if (value === 1024) return "1024";
  if (value === 1536) return "1536";
  if (value === 3072) return "3072";
  return "";
}

function getEmbeddingDimensionsValue(
  value: EditModelEmbeddingDimensionsValue,
): UpdateModelEmbeddingDimensions | null {
  if (!value) {
    return null;
  }

  return EMBEDDING_DIMENSION_MAP[value];
}

function shouldRequireOutputModalities(
  embeddingDimensions: EditModelEmbeddingDimensionsValue,
): boolean {
  return !embeddingDimensions;
}
