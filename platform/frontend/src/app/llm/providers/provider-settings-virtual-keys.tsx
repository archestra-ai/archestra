"use client";

import type { archestraApiTypes } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { Plus, Trash2 } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSetProviderAction } from "./layout";
import {
  type ChatApiKeyResponse,
  PROVIDER_CONFIG,
} from "@/components/chat-api-key-form";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  useAllVirtualApiKeys,
  useChatApiKeys,
} from "@/lib/chat-settings.query";
import { useFeature } from "@/lib/config.query";
import { CreateVirtualKeyDialog } from "./create-virtual-key-dialog";
import { DeleteVirtualKeyDialog } from "./delete-virtual-key-dialog";

type VirtualKeyWithParent =
  archestraApiTypes.GetAllVirtualApiKeysResponses["200"]["data"][number];

/**
 * Format an expiration date as a human-readable relative string.
 * e.g. "in 30 days", "in about 2 hours", "Never"
 */
function formatExpiration(date: Date | string | null): string {
  if (!date) return "Never";
  const d = typeof date === "string" ? new Date(date) : date;
  if (d <= new Date()) return "Expired";
  return formatDistanceToNow(d, { addSuffix: true });
}

const DEFAULT_PAGE_SIZE = 20;

export function ProviderSettingsVirtualKeys() {
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const { data: response, isPending } = useAllVirtualApiKeys({
    limit: pageSize,
    offset: pageIndex * pageSize,
  });
  const virtualKeys = response?.data ?? [];
  const paginationMeta = response?.pagination;

  const { data: apiKeys = [] } = useChatApiKeys();
  const defaultExpirationSeconds = useFeature(
    "virtualKeyDefaultExpirationSeconds",
  );

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [deletingKey, setDeletingKey] = useState<VirtualKeyWithParent | null>(
    null,
  );

  const handlePaginationChange = useCallback(
    (pagination: { pageIndex: number; pageSize: number }) => {
      setPageIndex(pagination.pageIndex);
      setPageSize(pagination.pageSize);
    },
    [],
  );

  const columns: ColumnDef<VirtualKeyWithParent>[] = useMemo(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <span className="font-medium">{row.original.name}</span>
        ),
      },
      {
        accessorKey: "tokenStart",
        header: "Token",
        cell: ({ row }) => (
          <code className="text-xs text-muted-foreground">
            {row.original.tokenStart}...
          </code>
        ),
      },
      {
        accessorKey: "parentKeyName",
        header: "Provider API Key",
        cell: ({ row }) => {
          const provider = row.original
            .parentKeyProvider as ChatApiKeyResponse["provider"];
          const config = PROVIDER_CONFIG[provider];
          return (
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
              <span className="text-sm">{row.original.parentKeyName}</span>
            </div>
          );
        },
      },
      {
        accessorKey: "expiresAt",
        header: "Expires",
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {formatExpiration(row.original.expiresAt)}
          </span>
        ),
      },
      {
        accessorKey: "lastUsedAt",
        header: "Last Used",
        cell: ({ row }) =>
          row.original.lastUsedAt ? (
            <span className="text-sm text-muted-foreground">
              {new Date(row.original.lastUsedAt).toLocaleDateString()}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">Never</span>
          ),
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              setDeletingKey(row.original);
              setIsDeleteDialogOpen(true);
            }}
          >
            <Trash2 className="h-3 w-3 text-destructive" />
          </Button>
        ),
      },
    ],
    [],
  );

  // API keys that can have virtual keys (including system keys for keyless providers like Vertex AI)
  const parentableKeys = apiKeys;

  const setProviderAction = useSetProviderAction();
  useEffect(() => {
    setProviderAction(
      <Button
        onClick={() => setIsCreateDialogOpen(true)}
        disabled={parentableKeys.length === 0}
      >
        <Plus className="h-4 w-4 mr-2" />
        Create Virtual Key
      </Button>,
    );
    return () => setProviderAction(null);
  }, [setProviderAction, parentableKeys.length]);

  return (
    <>
      <DataTable
        columns={columns}
        data={virtualKeys}
        getRowId={(row) => row.id}
        hideSelectedCount
        isLoading={isPending}
        emptyMessage={
          parentableKeys.length === 0
            ? "Add an API key first to create virtual keys"
            : "No virtual keys yet"
        }
        manualPagination
        pagination={{
          pageIndex,
          pageSize,
          total: paginationMeta?.total ?? 0,
        }}
        onPaginationChange={handlePaginationChange}
      />

      <CreateVirtualKeyDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        parentableKeys={parentableKeys}
        defaultExpirationSeconds={defaultExpirationSeconds ?? null}
      />

      <DeleteVirtualKeyDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        virtualKey={deletingKey}
      />
    </>
  );
}
