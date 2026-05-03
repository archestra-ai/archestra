"use client";

import {
  type archestraApiTypes,
  INPUT_MODALITY_OPTIONS,
  type ModelInputModality,
  type ModelOutputModality,
  OUTPUT_MODALITY_OPTIONS,
  SUPPORTED_EMBEDDING_DIMENSIONS,
} from "@shared";
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
import { PROVIDER_CONFIG } from "@/components/llm-provider-api-key-form";
import { LlmProviderApiKeyFilterSelect } from "@/components/llm-provider-options";
import {
  BestModelBadge,
  EmbeddingModelBadge,
  FastestModelBadge,
  UnknownCapabilitiesBadge,
} from "@/components/model-badges";
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
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  type ModelWithApiKeys,
  useModelsWithApiKeys,
  useSyncLlmModels,
  useUpdateModel,
} from "@/lib/llm-models.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useSetProviderAction } from "../layout";

export default function ModelsPage() {
  const { data: models = [], isPending, refetch } = useModelsWithApiKeys();
  const { data: apiKeys = [] } = useLlmProviderApiKeys();
  const syncModelsMutation = useSyncLlmModels();
  const updateModel = useUpdateModel();
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);
  const [search, setSearch] = useState("");
  const [apiKeyFilter, setApiKeyFilter] = useState<string>("all");
  const [modelTypeFilter, setModelTypeFilter] = useState<
    "all" | "chat" | "embedding"
  >("all");
  const [editingModel, setEditingModel] = useState<ModelWithApiKeys | null>(
    null,
  );

  const filteredModels = useMemo(() => {
    let result = models;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((m) => m.modelId.toLowerCase().includes(q));
    }
    if (apiKeyFilter !== "all") {
      result = result.filter((m) =>
        m.apiKeys.some((k) => k.id === apiKeyFilter),
      );
    }
    if (modelTypeFilter === "embedding") {
      result = result.filter((m) => m.embeddingDimensions !== null);
    } else if (modelTypeFilter === "chat") {
      result = result.filter((m) => m.embeddingDimensions === null);
    }
    // Stable sort so rows don't jump when data refetches after edits
    return [...result].sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) ||
        a.modelId.localeCompare(b.modelId),
    );
  }, [models, search, apiKeyFilter, modelTypeFilter]);

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

  const handleRefresh = useCallback(async () => {
    setIsRefreshingModels(true);
    try {
      await syncModelsMutation.mutateAsync();
      await refetch();
    } finally {
      setIsRefreshingModels(false);
    }
  }, [syncModelsMutation, refetch]);

  const setProviderAction = useSetProviderAction();
  useEffect(() => {
    setProviderAction(
      <Button onClick={handleRefresh} disabled={isRefreshingModels}>
        <RefreshCw
          className={`h-4 w-4 ${isRefreshingModels ? "animate-spin" : ""}`}
        />
        {isRefreshingModels ? "Refreshing..." : "Refresh Models"}
      </Button>,
    );
    return () => setProviderAction(null);
  }, [setProviderAction, isRefreshingModels, handleRefresh]);

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
        cell: ({ row }) => (
          <div className="min-w-0 space-y-2">
            <span className="font-mono text-sm">{row.original.modelId}</span>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              {row.original.isFastest && <FastestModelBadge />}
              {row.original.isBest && <BestModelBadge />}
              {row.original.embeddingDimensions !== null && (
                <EmbeddingModelBadge />
              )}
            </div>
          </div>
        ),
      },
      {
        accessorKey: "apiKeys",
        header: "Source",
        cell: ({ row }) => {
          const apiKeys = row.original.apiKeys;
          if (apiKeys.length === 0) {
            if (row.original.discoveredViaLlmProxy) {
              return (
                <Badge variant="secondary" className="text-xs gap-1">
                  <ArrowLeftRight className="h-3 w-3 shrink-0" />
                  <span>LLM Proxy</span>
                </Badge>
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

  return (
    <>
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
            <LlmProviderApiKeyFilterSelect
              value={apiKeyFilter}
              onValueChange={setApiKeyFilter}
              allLabel="All provider API keys"
              className="w-full sm:w-[280px]"
              options={availableApiKeys.flatMap(([id, { name, provider }]) => {
                const config = PROVIDER_CONFIG[provider];
                if (!config) return [];
                return [
                  {
                    value: id,
                    icon: config.icon,
                    providerName: config.name,
                    keyName: name,
                  },
                ];
              })}
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
            search || apiKeyFilter !== "all" || modelTypeFilter !== "all",
          )}
          filteredEmptyMessage="No models match your filters. Try adjusting your search."
          onClearFilters={() => {
            setSearch("");
            setApiKeyFilter("all");
            setModelTypeFilter("all");
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
    </>
  );
}

// --- Edit Model Dialog ---

type UpdateModelBody = archestraApiTypes.UpdateModelData["body"];
type UpdateModelEmbeddingDimensions = NonNullable<
  UpdateModelBody["embeddingDimensions"]
>;

const EMBEDDING_DIMENSION_MAP = {
  "768": 768,
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
    const embeddingDimensions = getEmbeddingDimensionsValue(
      values.embeddingDimensions,
    );

    const result = await updateModel.mutateAsync({
      id: model.id,
      customPricePerMillionInput: inputPrice,
      customPricePerMillionOutput: outputPrice,
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
                rules={{
                  validate: (v) => {
                    if (!v) return true;
                    const n = parseFloat(v);
                    if (Number.isNaN(n) || n < 0)
                      return "Must be a non-negative number";
                    return true;
                  },
                }}
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
                rules={{
                  validate: (v) => {
                    if (!v) return true;
                    const n = parseFloat(v);
                    if (Number.isNaN(n) || n < 0)
                      return "Must be a non-negative number";
                    return true;
                  },
                }}
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

function formatContextLength(contextLength: number | null): string {
  if (contextLength === null) return "-";
  if (contextLength >= 1000000) {
    return `${(contextLength / 1000000).toFixed(contextLength % 1000000 === 0 ? 0 : 1)}M`;
  }
  if (contextLength >= 1000) {
    return `${(contextLength / 1000).toFixed(contextLength % 1000 === 0 ? 0 : 1)}K`;
  }
  return contextLength.toString();
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

function getFallbackPricing(model: ModelWithApiKeys): {
  input: string;
  output: string;
} {
  // Tier 2: models.dev synced price (per-token → per-million)
  if (
    model.promptPricePerToken != null &&
    model.completionPricePerToken != null
  ) {
    return {
      input: (parseFloat(model.promptPricePerToken) * 1_000_000).toFixed(2),
      output: (parseFloat(model.completionPricePerToken) * 1_000_000).toFixed(
        2,
      ),
    };
  }
  // Tier 3: default fallback
  const isCheaper = ["-haiku", "-nano", "-mini"].some((p) =>
    model.modelId.toLowerCase().includes(p),
  );
  const price = isCheaper ? "30.00" : "50.00";
  return { input: price, output: price };
}

function getDefaults(model: ModelWithApiKeys): EditModelFormValues {
  return {
    customPricePerMillionInput: model.customPricePerMillionInput ?? "",
    customPricePerMillionOutput: model.customPricePerMillionOutput ?? "",
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
  if (value === 768) return "768";
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
