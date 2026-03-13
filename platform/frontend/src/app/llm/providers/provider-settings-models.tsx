"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
  ArrowLeftRight,
  Check,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Server,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useMemo, useState } from "react";
import { PROVIDER_CONFIG } from "@/components/chat-api-key-form";
import { LoadingWrapper } from "@/components/loading";
import {
  BestModelBadge,
  FastestModelBadge,
  UnknownCapabilitiesBadge,
} from "@/components/model-badges";
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
} from "@/lib/chat-models.query";
import { useSyncChatModels } from "@/lib/chat-settings.query";
import { EditModelDialog } from "./edit-model-dialog";

export function ProviderSettingsModels() {
  const { data: models = [], isPending, refetch } = useModelsWithApiKeys();
  const syncModelsMutation = useSyncChatModels();
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
    await syncModelsMutation.mutateAsync();
    await refetch();
  }, [syncModelsMutation, refetch]);

  const columns: ColumnDef<ModelWithApiKeys>[] = useMemo(
    () => [
      {
        accessorKey: "provider",
        header: "Provider",
        cell: ({ row }) => {
          const provider = row.original.provider;
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
        id: "actions",
        header: "",
        size: 50,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => setEditingModel(row.original)}
          >
            <Pencil className="h-4 w-4" />
          </Button>
        ),
      },
    ],
    [],
  );

  return (
    <>
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
                Models available from your configured API keys. Click the edit
                button to update pricing and modalities. Use Refresh to re-fetch
                models and capabilities from providers.
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
                  href="/llm/providers/api-keys"
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
                <Select value={apiKeyFilter} onValueChange={setApiKeyFilter}>
                  <SelectTrigger className="w-[200px]">
                    <SelectValue placeholder="All API keys" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All API keys</SelectItem>
                    {availableApiKeys.map(([id, { name, provider }]) => {
                      const config = PROVIDER_CONFIG[provider];
                      return (
                        <SelectItem key={id} value={id}>
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
                            <span>{name}</span>
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
