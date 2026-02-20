"use client";

import type { SupportedProvider } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Check, Loader2, RefreshCw, Server, Star, Zap } from "lucide-react";
import Image from "next/image";
import { useCallback, useMemo } from "react";
import { PROVIDER_CONFIG } from "@/components/chat-api-key-form";
import { LoadingWrapper } from "@/components/loading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  type ModelWithApiKeys,
  useModelsWithApiKeys,
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

export function ProviderSettingsModels() {
  const { data: models = [], isPending, refetch } = useModelsWithApiKeys();
  const syncModelsMutation = useSyncChatModels();

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
        accessorKey: "capabilities.pricePerMillionInput",
        header: "$/M Input",
        cell: ({ row }) => {
          if (hasUnknownCapabilities(row.original)) return null;
          const price = row.original.capabilities?.pricePerMillionInput;
          if (!price) return null;
          return <span className="text-sm font-mono">${price}</span>;
        },
      },
      {
        accessorKey: "capabilities.pricePerMillionOutput",
        header: "$/M Output",
        cell: ({ row }) => {
          if (hasUnknownCapabilities(row.original)) return null;
          const price = row.original.capabilities?.pricePerMillionOutput;
          if (!price) return null;
          return <span className="text-sm font-mono">${price}</span>;
        },
      },
    ],
    [],
  );

  return (
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
  );
}
