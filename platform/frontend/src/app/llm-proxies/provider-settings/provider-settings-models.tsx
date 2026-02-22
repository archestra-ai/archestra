"use client";

import type { SupportedProvider } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Check,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Star,
  X,
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
  const [editingModelId, setEditingModelId] = useState<string | null>(null);

  const handleRefresh = useCallback(async () => {
    await syncModelsMutation.mutateAsync();
    await refetch();
  }, [syncModelsMutation, refetch]);

  const handleSave = useCallback(
    async (modelId: string, input: string, output: string) => {
      await updatePricing.mutateAsync({
        id: modelId,
        customPricePerMillionInput: input || null,
        customPricePerMillionOutput: output || null,
      });
      setEditingModelId(null);
    },
    [updatePricing],
  );

  const handleReset = useCallback(
    async (modelId: string) => {
      await updatePricing.mutateAsync({
        id: modelId,
        customPricePerMillionInput: null,
        customPricePerMillionOutput: null,
      });
      setEditingModelId(null);
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
      {
        id: "pricing",
        header: "$/M (Input / Output)",
        cell: ({ row }) => <PricingCell model={row.original} />,
      },
    ],
    [],
  );

  return (
    <PricingEditContext.Provider
      value={{
        editingModelId,
        setEditingModelId,
        onSave: handleSave,
        onReset: handleReset,
        isSaving: updatePricing.isPending,
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
            <DataTable
              columns={columns}
              data={models}
              getRowId={(row) => row.id}
              hideSelectedCount
            />
          )}
        </div>
      </LoadingWrapper>
    </PricingEditContext.Provider>
  );
}

// --- Pricing edit context ---

type PricingEditContextValue = {
  editingModelId: string | null;
  setEditingModelId: (id: string | null) => void;
  onSave: (modelId: string, input: string, output: string) => Promise<void>;
  onReset: (modelId: string) => Promise<void>;
  isSaving: boolean;
};

const PricingEditContext = createContext<PricingEditContextValue>({
  editingModelId: null,
  setEditingModelId: () => {},
  onSave: async () => {},
  onReset: async () => {},
  isSaving: false,
});

// --- Pricing cell with integrated editing ---

function PricingCell({ model }: { model: ModelWithApiKeys }) {
  const { editingModelId, setEditingModelId, onSave, onReset, isSaving } =
    useContext(PricingEditContext);
  const isEditing = editingModelId === model.id;
  const isCustom =
    (model.capabilities as Record<string, unknown>)?.priceSource === "custom";

  if (hasUnknownCapabilities(model)) return null;

  if (isEditing) {
    return (
      <PricingEditForm
        model={model}
        onSave={onSave}
        onCancel={() => setEditingModelId(null)}
        isSaving={isSaving}
      />
    );
  }

  const inputPrice = model.capabilities?.pricePerMillionInput;
  const outputPrice = model.capabilities?.pricePerMillionOutput;
  const source = (model.capabilities as Record<string, unknown>)?.priceSource as
    | string
    | undefined;

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1">
        {inputPrice || outputPrice ? (
          <span className="text-sm font-mono">
            ${inputPrice ?? "-"} / ${outputPrice ?? "-"}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">-</span>
        )}
        {source && <PriceSourceBadge source={source} />}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={() => setEditingModelId(model.id)}
        disabled={editingModelId !== null}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      {isCustom && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground"
          onClick={() => onReset(model.id)}
          disabled={editingModelId !== null}
          title="Reset to default pricing"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

/**
 * Self-contained editing form with local state.
 * Owns its own input/output values so typing doesn't
 * cause column re-definition or cell remounting.
 */
function PricingEditForm({
  model,
  onSave,
  onCancel,
  isSaving,
}: {
  model: ModelWithApiKeys;
  onSave: (modelId: string, input: string, output: string) => Promise<void>;
  onCancel: () => void;
  isSaving: boolean;
}) {
  const [input, setInput] = useState(
    model.capabilities?.pricePerMillionInput ?? "",
  );
  const [output, setOutput] = useState(
    model.capabilities?.pricePerMillionOutput ?? "",
  );

  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(model.id, input, output);
      }}
    >
      <Input
        type="number"
        min="0"
        step="0.01"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        className="h-7 w-20 text-sm font-mono"
        placeholder="Input"
        autoFocus
        disabled={isSaving}
      />
      <span className="text-muted-foreground">/</span>
      <Input
        type="number"
        min="0"
        step="0.01"
        value={output}
        onChange={(e) => setOutput(e.target.value)}
        className="h-7 w-20 text-sm font-mono"
        placeholder="Output"
        disabled={isSaving}
      />
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        type="submit"
        disabled={isSaving}
      >
        <Save className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        type="button"
        onClick={onCancel}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </form>
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
