"use client";

import {
  type archestraApiTypes,
  E2eTestId,
  getDeleteVirtualKeyButtonTestId,
  getVirtualKeyRowTestId,
} from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Key, Loader2, Plus, Trash2 } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ChatApiKeyResponse,
  PROVIDER_CONFIG,
} from "@/components/chat-api-key-form";
import { CopyableCode } from "@/components/copyable-code";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExpirationDateTimeField } from "@/components/expiration-date-time-field";
import { FormDialog } from "@/components/form-dialog";
import {
  LlmProviderApiKeyFilterSelect,
  LlmProviderApiKeySelectItems,
} from "@/components/llm-provider-options";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useAllVirtualApiKeys,
  useChatApiKeys,
  useCreateVirtualApiKey,
  useDeleteVirtualApiKey,
} from "@/lib/chat/chat-settings.query";
import { useFeature } from "@/lib/config/config.query";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import {
  formatRelativeTime,
  formatRelativeTimeFromNow,
} from "@/lib/utils/date-time";
import { useSetProviderAction } from "../layout";

type VirtualKeyWithParent =
  archestraApiTypes.GetAllVirtualApiKeysResponses["200"]["data"][number];

export default function VirtualKeysPage() {
  const {
    searchParams,
    pageIndex,
    pageSize,
    offset,
    setPagination,
    updateQueryParams,
  } = useDataTableQueryParams();
  const search = searchParams.get("search") || "";
  const chatApiKeyIdFilter = searchParams.get("chatApiKeyId") || "all";

  const { data: response, isPending } = useAllVirtualApiKeys({
    limit: pageSize,
    offset,
    search: search || undefined,
    chatApiKeyId: chatApiKeyIdFilter === "all" ? undefined : chatApiKeyIdFilter,
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

  const columns: ColumnDef<VirtualKeyWithParent>[] = useMemo(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <span
            className="font-medium"
            data-testid={getVirtualKeyRowTestId(row.original.name)}
          >
            {row.original.name}
          </span>
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
        accessorKey: "createdAt",
        header: "Created",
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {formatRelativeTimeFromNow(row.original.createdAt)}
          </span>
        ),
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
          <TableRowActions
            actions={[
              {
                icon: <Trash2 className="h-4 w-4" />,
                label: "Delete",
                variant: "destructive",
                testId: getDeleteVirtualKeyButtonTestId(row.original.name),
                onClick: () => {
                  setDeletingKey(row.original);
                  setIsDeleteDialogOpen(true);
                },
              },
            ]}
          />
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
        data-testid={E2eTestId.AddVirtualKeyButton}
      >
        <Plus className="h-4 w-4 mr-2" />
        Create Virtual Key
      </Button>,
    );
    return () => setProviderAction(null);
  }, [setProviderAction, parentableKeys.length]);

  return (
    <>
      <div
        className="mb-4 flex flex-wrap gap-4"
        data-testid={E2eTestId.VirtualKeysPage}
      >
        <SearchInput
          objectNamePlural="virtual keys"
          searchFields={["name"]}
          paramName="search"
        />
        <LlmProviderApiKeyFilterSelect
          value={chatApiKeyIdFilter}
          onValueChange={(value) =>
            updateQueryParams({
              chatApiKeyId: value === "all" ? null : value,
              page: "1",
            })
          }
          allLabel="All provider API keys"
          options={parentableKeys.map((key) => {
            const config = PROVIDER_CONFIG[key.provider];
            return {
              value: key.id,
              icon: config.icon,
              providerName: config.name,
              keyName: key.name,
            };
          })}
        />
      </div>

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
        onPaginationChange={setPagination}
        hasActiveFilters={Boolean(search || chatApiKeyIdFilter !== "all")}
        filteredEmptyMessage="No virtual keys match your filters. Try adjusting your search."
        onClearFilters={() =>
          updateQueryParams({
            search: null,
            chatApiKeyId: null,
            page: "1",
          })
        }
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

// --- Dialogs ---

function CreateVirtualKeyDialog({
  open,
  onOpenChange,
  parentableKeys,
  defaultExpirationSeconds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentableKeys: ChatApiKeyResponse[];
  defaultExpirationSeconds: number | null;
}) {
  const createMutation = useCreateVirtualApiKey();

  const [newKeyName, setNewKeyName] = useState("");
  const [selectedParentKeyId, setSelectedParentKeyId] = useState<string>("");
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [createdKeyValue, setCreatedKeyValue] = useState<string | null>(null);
  const [createdKeyExpiresAt, setCreatedKeyExpiresAt] = useState<Date | null>(
    null,
  );

  const defaultParentKeyId = parentableKeys[0]?.id ?? "";
  const prevOpenRef = useRef(open);

  // Reset form state only on open transition (false → true)
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (open && !wasOpen) {
      setCreatedKeyValue(null);
      setCreatedKeyExpiresAt(null);
      setNewKeyName("");
      setSelectedParentKeyId(defaultParentKeyId);
      setExpiresAt(computeDefaultExpiresAt(defaultExpirationSeconds));
    }
  }, [open, defaultParentKeyId, defaultExpirationSeconds]);

  const handleCreate = useCallback(async () => {
    if (!newKeyName.trim() || !selectedParentKeyId) return;
    try {
      const result = await createMutation.mutateAsync({
        chatApiKeyId: selectedParentKeyId,
        data: {
          name: newKeyName.trim(),
          expiresAt: expiresAt ?? undefined,
        },
      });
      setNewKeyName("");
      if (result?.value) {
        setCreatedKeyValue(result.value);
        setCreatedKeyExpiresAt(expiresAt);
      }
    } catch {
      // Handled by mutation
    }
  }, [newKeyName, selectedParentKeyId, expiresAt, createMutation]);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        createdKeyValue ? "Virtual API Key Created" : "Create Virtual API Key"
      }
      description={
        createdKeyValue
          ? undefined
          : "Create a virtual key linked to one of your provider API keys"
      }
      size="small"
    >
      <DialogForm onSubmit={handleCreate}>
        <DialogBody
          className="space-y-4"
          data-testid={E2eTestId.VirtualKeyCreateDialog}
        >
          {createdKeyValue ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Key className="h-4 w-4" />
                Copy this key now. It won&apos;t be shown again.
              </div>
              <div data-testid={E2eTestId.VirtualKeyValue}>
                <CopyableCode value={createdKeyValue} />
              </div>
              <div className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Expires:</span>{" "}
                {formatExpiration(createdKeyExpiresAt)}
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label>Provider API Key</Label>
                <Select
                  value={selectedParentKeyId}
                  onValueChange={setSelectedParentKeyId}
                >
                  <SelectTrigger
                    className="w-full"
                    data-testid={E2eTestId.VirtualKeyParentKeySelect}
                  >
                    <SelectValue placeholder="Select an API key" />
                  </SelectTrigger>
                  <SelectContent>
                    <LlmProviderApiKeySelectItems
                      options={parentableKeys.map((key) => {
                        const config = PROVIDER_CONFIG[key.provider];
                        return {
                          value: key.id,
                          icon: config.icon,
                          providerName: config.name,
                          keyName: key.name,
                          secondaryLabel: config.name,
                        };
                      })}
                    />
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="virtual-key-name">Name</Label>
                <Input
                  id="virtual-key-name"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="My virtual key"
                />
              </div>

              <div className="space-y-2">
                <ExpirationDateTimeField
                  value={expiresAt}
                  onChange={setExpiresAt}
                  noExpirationText="Key will never expire"
                  formatExpiration={formatExpiration}
                />
              </div>
            </>
          )}
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {createdKeyValue ? "Close" : "Cancel"}
          </Button>
          {!createdKeyValue && (
            <Button
              type="submit"
              disabled={
                !newKeyName.trim() ||
                !selectedParentKeyId ||
                createMutation.isPending
              }
            >
              {createMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Create
            </Button>
          )}
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

function DeleteVirtualKeyDialog({
  open,
  onOpenChange,
  virtualKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  virtualKey: VirtualKeyWithParent | null;
}) {
  const deleteMutation = useDeleteVirtualApiKey();

  return (
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete Virtual Key"
      description={
        <div data-testid={E2eTestId.VirtualKeyDeleteDialog}>
          Are you sure you want to delete "{virtualKey?.name}"? This action
          cannot be undone.
        </div>
      }
      confirmLabel="Delete"
      isPending={deleteMutation.isPending}
      onConfirm={() => {
        if (!virtualKey) return;

        deleteMutation.mutate(
          {
            chatApiKeyId: virtualKey.chatApiKeyId,
            id: virtualKey.id,
          },
          {
            onSuccess: () => {
              onOpenChange(false);
            },
          },
        );
      }}
    />
  );
}

// --- Internal helpers ---

function formatExpiration(date: Date | string | null): string {
  return formatRelativeTime(date);
}

function computeDefaultExpiresAt(defaultSeconds: number | null): Date | null {
  if (defaultSeconds === null) return null;
  return new Date(Date.now() + defaultSeconds * 1000);
}
