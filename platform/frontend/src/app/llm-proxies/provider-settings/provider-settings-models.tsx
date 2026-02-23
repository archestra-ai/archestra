"use client";

import type { SupportedProvider } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Check,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Star,
  Zap,
} from "lucide-react";
import Image from "next/image";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { PROVIDER_CONFIG } from "@/components/chat-api-key-form";
import { LoadingWrapper } from "@/components/loading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type ModelWithApiKeys,
  useModelsWithApiKeys,
  useUpdateModelPricing,
} from "@/lib/chat-models.query";
import {
  type ChatApiKeyScope,
  useSyncChatModels,
} from "@/lib/chat-settings.query";

const SCOPE_ICONS: Record<ChatApiKeyScope, React.ReactNode> = {
  personal: null,
  team: null,
  org_wide: null,
};

export function ProviderSettingsModels() {
  const { data: models = [], isPending, refetch } = useModelsWithApiKeys();
  const syncModelsMutation = useSyncChatModels();
  const updatePricing = useUpdateModelPricing();
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState<string>("all");

  const filteredModels = useMemo(() => {
    let result = models;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((m) => m.modelId.toLowerCase().includes(q));
    }
    if (providerFilter !== "all") {
      result = result.filter((m) => m.provider === providerFilter);
    }
    return result;
  }, [models, search, providerFilter]);

  const availableProviders = useMemo(() => {
    const providers = new Set(models.map((m) => m.provider));
    return Array.from(providers).sort();
  }, [models]);

  const handleRefresh = useCallback(async () => {
    await syncModelsMutation.mutateAsync();
    await refetch();
  }, [syncModelsMutation, refetch]);

  const handleSaveField = useCallback(
    async (
      modelId: string,
      field: "input" | "output",
      value: string | null,
    ) => {
      const model = models.find((m) => m.id === modelId);
      // When clearing a field, reset both to null (validation requires both or neither)
      if (!value) {
        await updatePricing.mutateAsync({
          id: modelId,
          customPricePerMillionInput: null,
          customPricePerMillionOutput: null,
        });
        return;
      }
      // Use existing custom price for the unchanged field,
      // falling back to effective price from capabilities
      const currentInput =
        model?.customPricePerMillionInput ??
        model?.capabilities?.pricePerMillionInput ??
        null;
      const currentOutput =
        model?.customPricePerMillionOutput ??
        model?.capabilities?.pricePerMillionOutput ??
        null;
      await updatePricing.mutateAsync({
        id: modelId,
        customPricePerMillionInput:
          field === "input" ? value : currentInput || null,
        customPricePerMillionOutput:
          field === "output" ? value : currentOutput || null,
      });
    },
    [updatePricing, models],
  );

  const handleReset = useCallback(
    async (modelId: string) => {
      await updatePricing.mutateAsync({
        id: modelId,
        customPricePerMillionInput: null,
        customPricePerMillionOutput: null,
      });
    },
    [updatePricing],
  );

  // Column defs are stable — no editing state in deps
  const columns: ColumnDef<ModelWithApiKeys>[] = useMemo(
    () => [
      {
        accessorKey: "provider",
        header: "Provider",
        cell: ({ row }) => {
          const provider = row.original.provider as SupportedProvider;
          const config = PROVIDER_CONFIG[provider];
          if (!config) {
            return <span className="text-sm">{provider}</span>;
          }
          return (
            <div className="flex items-center gap-2">
              <Image
                src={config.icon}
                alt={config.name}
                width={20}
                height={20}
                className="rounded dark:invert"
              />
              <span>{config.name}</span>
            </div>
          );
        },
      },
      {
        accessorKey: "modelId",
        header: "Model ID",
        size: 250,
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
        header: "API Keys",
        cell: ({ row }) => {
          const apiKeys = row.original.apiKeys;
          if (apiKeys.length === 0) {
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
                  {apiKey.isSystem ? (
                    <Server className="h-3 w-3 shrink-0" />
                  ) : (
                    <span className="shrink-0">
                      {SCOPE_ICONS[apiKey.scope as ChatApiKeyScope]}
                    </span>
                  )}
                  <span className="truncate">{apiKey.name}</span>
                </Badge>
              ))}
            </div>
          );
        },
      },
      {
        id: "pricingInput",
        header: "$/M Input",
        cell: ({ row }) => (
          <PricingValueCell model={row.original} field="input" />
        ),
      },
      {
        id: "pricingOutput",
        header: "$/M Output",
        cell: ({ row }) => (
          <PricingValueCell model={row.original} field="output" />
        ),
      },
      {
        id: "pricingActions",
        header: "",
        cell: ({ row }) => <PricingResetCell model={row.original} />,
      },
      {
        accessorKey: "capabilities.contextLength",
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
        accessorKey: "capabilities.inputModalities",
        header: "Input",
        cell: ({ row }) => {
          if (hasUnknownCapabilities(row.original)) return null;
          const modalities = row.original.capabilities?.inputModalities;
          if (!modalities || modalities.length === 0) return null;
          return (
            <div className="flex flex-wrap gap-1">
              {modalities.map((modality) => (
                <Badge key={modality} variant="secondary" className="text-xs">
                  {modality}
                </Badge>
              ))}
            </div>
          );
        },
      },
      {
        accessorKey: "capabilities.outputModalities",
        header: "Output",
        cell: ({ row }) => {
          if (hasUnknownCapabilities(row.original)) return null;
          const modalities = row.original.capabilities?.outputModalities;
          if (!modalities || modalities.length === 0) return null;
          return (
            <div className="flex flex-wrap gap-1">
              {modalities.map((modality) => (
                <Badge key={modality} variant="secondary" className="text-xs">
                  {modality}
                </Badge>
              ))}
            </div>
          );
        },
      },
      {
        accessorKey: "capabilities.supportsToolCalling",
        header: "Tools",
        cell: ({ row }) => {
          if (hasUnknownCapabilities(row.original)) return null;
          const supportsTools = row.original.capabilities?.supportsToolCalling;
          if (supportsTools === null || supportsTools === undefined)
            return null;
          return supportsTools ? (
            <Check className="h-4 w-4 text-green-500" />
          ) : null;
        },
      },
    ],
    [],
  );

  return (
    <PricingEditContext.Provider
      value={{
        onSaveField: handleSaveField,
        onReset: handleReset,
      }}
    >
      <LoadingWrapper
        isPending={isPending}
        loadingFallback={
          <div className="flex items-center justify-center h-32">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        }
      >
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <div>
              <h2 className="text-lg font-semibold">Available Models</h2>
              <p className="text-sm text-muted-foreground">
                Models available from your configured API keys
              </p>
            </div>
            <Button
              variant="outline"
              onClick={handleRefresh}
              disabled={syncModelsMutation.isPending}
            >
              <RefreshCw
                className={`h-4 w-4 mr-2 ${syncModelsMutation.isPending ? "animate-spin" : ""}`}
              />
              Refresh models
            </Button>
          </div>

          {models.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <p>
                No models available.{" "}
                <a
                  href="/llm-proxies/provider-settings"
                  className="underline hover:text-foreground"
                >
                  Add an API key
                </a>{" "}
                to see available models.
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <div className="relative w-72">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search models..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-8"
                  />
                </div>
                <Select
                  value={providerFilter}
                  onValueChange={setProviderFilter}
                >
                  <SelectTrigger className="w-[200px]">
                    <SelectValue placeholder="All providers" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All providers</SelectItem>
                    {availableProviders.map((provider) => {
                      const config =
                        PROVIDER_CONFIG[provider as SupportedProvider];
                      return (
                        <SelectItem key={provider} value={provider}>
                          <div className="flex items-center gap-2">
                            {config && (
                              <Image
                                src={config.icon}
                                alt={config.name}
                                width={16}
                                height={16}
                                className="rounded dark:invert"
                              />
                            )}
                            <span>{config?.name ?? provider}</span>
                          </div>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
              <DataTable
                columns={columns}
                data={filteredModels}
                getRowId={(row) => row.id}
                hideSelectedCount
              />
            </>
          )}
        </div>
      </LoadingWrapper>
    </PricingEditContext.Provider>
  );
}

// --- Pricing edit context ---

type PricingEditContextValue = {
  onSaveField: (
    modelId: string,
    field: "input" | "output",
    value: string | null,
  ) => Promise<void>;
  onReset: (modelId: string) => Promise<void>;
};

const PricingEditContext = createContext<PricingEditContextValue>({
  onSaveField: async () => {},
  onReset: async () => {},
});

// --- Pricing cells (click-to-edit, blur-to-save) ---

function PricingValueCell({
  model,
  field,
}: {
  model: ModelWithApiKeys;
  field: "input" | "output";
}) {
  const { onSaveField } = useContext(PricingEditContext);
  const currentPrice =
    field === "input"
      ? model.capabilities?.pricePerMillionInput
      : model.capabilities?.pricePerMillionOutput;
  const source = (model.capabilities as Record<string, unknown>)?.priceSource as
    | string
    | undefined;

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentPrice ?? "");

  if (hasUnknownCapabilities(model)) return null;

  if (editing) {
    return (
      <Input
        type="number"
        min="0"
        step="0.01"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          setEditing(false);
          const newVal = value || null;
          const oldVal = currentPrice || null;
          if (newVal !== oldVal) {
            onSaveField(model.id, field, value || null);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur();
          }
          if (e.key === "Escape") {
            setValue(currentPrice ?? "");
            setEditing(false);
          }
        }}
        className="h-7 w-24 text-sm font-mono"
        placeholder={field === "input" ? "Input" : "Output"}
        autoFocus
      />
    );
  }

  return (
    <button
      type="button"
      className="flex items-center gap-1 cursor-pointer hover:bg-muted/50 rounded px-1 -mx-1 py-0.5"
      onClick={() => {
        setValue(currentPrice ?? "");
        setEditing(true);
      }}
    >
      {currentPrice ? (
        <span className="text-sm font-mono">${currentPrice}</span>
      ) : (
        <span className="text-sm text-muted-foreground">-</span>
      )}
      {field === "output" && source && <PriceSourceBadge source={source} />}
    </button>
  );
}

function PricingResetCell({ model }: { model: ModelWithApiKeys }) {
  const { onReset } = useContext(PricingEditContext);
  const isCustom =
    (model.capabilities as Record<string, unknown>)?.priceSource === "custom";

  if (hasUnknownCapabilities(model) || !isCustom) return null;

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 w-7 p-0 text-muted-foreground"
      onClick={() => onReset(model.id)}
      title="Reset to default pricing"
    >
      <RotateCcw className="h-3.5 w-3.5" />
    </Button>
  );
}

// --- Internal helpers and badge components ---

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

function UnknownCapabilitiesBadge() {
  return (
    <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded whitespace-nowrap">
      capabilities unknown
    </span>
  );
}

function FastestModelBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950 px-1.5 py-0.5 rounded whitespace-nowrap">
      <Zap className="h-3 w-3" />
      fastest
    </span>
  );
}

function BestModelBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-purple-700 dark:text-purple-400 bg-purple-100 dark:bg-purple-950 px-1.5 py-0.5 rounded whitespace-nowrap">
      <Star className="h-3 w-3" />
      best
    </span>
  );
}

function PriceSourceBadge({ source }: { source: string }) {
  if (source === "custom") {
    return (
      <span className="text-[10px] text-blue-700 dark:text-blue-400 bg-blue-100 dark:bg-blue-950 px-1.5 py-0.5 rounded whitespace-nowrap">
        custom
      </span>
    );
  }
  if (source === "default") {
    return (
      <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded whitespace-nowrap">
        default
      </span>
    );
  }
  return null;
}
