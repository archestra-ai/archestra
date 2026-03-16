"use client";

import type { ModelInputModality, ModelOutputModality } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ArrowLeftRight,
  Pencil,
  RefreshCw,
  RotateCcw,
  Server,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { PROVIDER_CONFIG } from "@/components/chat-api-key-form";
import { LlmProviderApiKeyFilterSelect } from "@/components/llm-provider-options";
import {
  BestModelBadge,
  FastestModelBadge,
  UnknownCapabilitiesBadge,
} from "@/components/model-badges";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogForm,
  DialogHeader,
  DialogStickyFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  type ModelWithApiKeys,
  useModelsWithApiKeys,
  useUpdateModel,
} from "@/lib/chat-models.query";
import { useChatApiKeys, useSyncChatModels } from "@/lib/chat-settings.query";
import { useSetProviderAction } from "../layout";

export default function ModelsPage() {
  const { data: models = [], isPending, refetch } = useModelsWithApiKeys();
  const { data: apiKeys = [] } = useChatApiKeys();
  const syncModelsMutation = useSyncChatModels();
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);
  const [search, setSearch] = useState("");
  const [apiKeyFilter, setApiKeyFilter] = useState<string>("all");
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
    // Stable sort so rows don't jump when data refetches after edits
    return [...result].sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) ||
        a.modelId.localeCompare(b.modelId),
    );
  }, [models, search, apiKeyFilter]);

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
          className={`h-4 w-4 mr-2 ${isRefreshingModels ? "animate-spin" : ""}`}
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
        header: "Model ID",
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm">{row.original.modelId}</span>
            {row.original.isFastest && <FastestModelBadge />}
            {row.original.isBest && <BestModelBadge />}
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
        size: 120,
        header: "$/M Input",
        cell: ({ row }) => {
          const price = row.original.capabilities?.pricePerMillionInput;
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
        size: 120,
        header: "$/M Output",
        cell: ({ row }) => {
          const price = row.original.capabilities?.pricePerMillionOutput;
          if (hasUnknownCapabilities(row.original)) return null;
          return price ? (
            <span className="text-sm font-mono">${price}</span>
          ) : (
            <span className="text-sm text-muted-foreground">-</span>
          );
        },
      },
      {
        accessorKey: "capabilities.contextLength",
        size: 100,
        header: "Context",
        cell: ({ row }) => {
          if (hasUnknownCapabilities(row.original)) {
            return <UnknownCapabilitiesBadge />;
          }
          return (
            <span className="text-sm">
              {formatContextLength(
                row.original.capabilities?.contextLength ?? null,
              )}
            </span>
          );
        },
      },
      {
        id: "actions",
        size: 60,
        header: "Actions",
        cell: ({ row }) => (
          <TableRowActions
            actions={[
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
    [],
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
          </div>
        )}
        <DataTable
          columns={columns}
          data={filteredModels}
          getRowId={(row) => row.id}
          hideSelectedCount
          isLoading={isPending}
          hasActiveFilters={Boolean(search || apiKeyFilter !== "all")}
          filteredEmptyMessage="No models match your filters. Try adjusting your search."
          onClearFilters={() => {
            setSearch("");
            setApiKeyFilter("all");
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

const INPUT_MODALITY_OPTIONS: Array<{
  value: ModelInputModality;
  label: string;
}> = [
  { value: "text", label: "Text" },
  { value: "image", label: "Image" },
  { value: "audio", label: "Audio" },
  { value: "video", label: "Video" },
  { value: "pdf", label: "PDF" },
];

const OUTPUT_MODALITY_OPTIONS: Array<{
  value: ModelOutputModality;
  label: string;
}> = [
  { value: "text", label: "Text" },
  { value: "image", label: "Image" },
  { value: "audio", label: "Audio" },
];

interface EditModelFormValues {
  customPricePerMillionInput: string;
  customPricePerMillionOutput: string;
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
  const updateModel = useUpdateModel();
  const providerConfig = PROVIDER_CONFIG[model.provider];
  const fallbackPricing = getFallbackPricing(model);
  const form = useForm<EditModelFormValues>({
    defaultValues: getDefaults(model),
  });

  useEffect(() => {
    if (open) {
      form.reset(getDefaults(model));
    }
  }, [open, model, form]);

  const handleSubmit = async (values: EditModelFormValues) => {
    const inputPrice = values.customPricePerMillionInput.trim() || null;
    const outputPrice = values.customPricePerMillionOutput.trim() || null;

    const result = await updateModel.mutateAsync({
      id: model.id,
      customPricePerMillionInput: inputPrice,
      customPricePerMillionOutput: outputPrice,
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Edit Model</DialogTitle>
          <DialogDescription>
            Update pricing and modality settings for this model.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <DialogForm
            onSubmit={form.handleSubmit(handleSubmit)}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
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
                          <Input
                            placeholder={fallbackPricing.input}
                            {...field}
                          />
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
                          <Input
                            placeholder={fallbackPricing.output}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              {/* Input Modalities */}
              <FormField
                control={form.control}
                name="inputModalities"
                rules={{
                  validate: (v) =>
                    v.length > 0 || "At least one input modality is required",
                }}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Input Modalities</FormLabel>
                    <FormControl>
                      <MultiSelect
                        items={INPUT_MODALITY_OPTIONS}
                        value={field.value}
                        onValueChange={field.onChange}
                        placeholder="Select input modalities..."
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Output Modalities */}
              <FormField
                control={form.control}
                name="outputModalities"
                rules={{
                  validate: (v) =>
                    v.length > 0 || "At least one output modality is required",
                }}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Output Modalities</FormLabel>
                    <FormControl>
                      <MultiSelect
                        items={OUTPUT_MODALITY_OPTIONS}
                        value={field.value}
                        onValueChange={field.onChange}
                        placeholder="Select output modalities..."
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <DialogStickyFooter>
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
            </DialogStickyFooter>
          </DialogForm>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// --- Internal helpers ---

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
  const capabilities = model.capabilities;
  if (!capabilities) return true;
  const hasInputModalities =
    capabilities.inputModalities && capabilities.inputModalities.length > 0;
  const hasOutputModalities =
    capabilities.outputModalities && capabilities.outputModalities.length > 0;
  const hasToolCalling = capabilities.supportsToolCalling !== null;
  const hasContextLength = capabilities.contextLength !== null;
  const hasPricing =
    capabilities.pricePerMillionInput !== null ||
    capabilities.pricePerMillionOutput !== null;
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
    inputModalities: model.inputModalities ?? [],
    outputModalities: model.outputModalities ?? [],
  };
}
