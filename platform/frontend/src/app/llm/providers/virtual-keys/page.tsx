"use client";

import type { archestraApiTypes } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { Key, Loader2, Plus, Trash2 } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ChatApiKeyResponse,
  PROVIDER_CONFIG,
} from "@/components/chat-api-key-form";
import { CopyableCode } from "@/components/copyable-code";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useAllVirtualApiKeys,
  useChatApiKeys,
  useCreateVirtualApiKey,
  useDeleteVirtualApiKey,
} from "@/lib/chat-settings.query";
import { useFeature } from "@/lib/config.query";
import { useSetProviderAction } from "../layout";

type VirtualKeyWithParent =
  archestraApiTypes.GetAllVirtualApiKeysResponses["200"]["data"][number];

export default function VirtualKeysPage() {
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(10);

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
        header: "",
        cell: ({ row }) => (
          <TableRowActions
            actions={[
              {
                icon: <Trash2 className="h-4 w-4" />,
                label: "Delete",
                variant: "destructive",
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {createdKeyValue
              ? "Virtual API Key Created"
              : "Create Virtual API Key"}
          </DialogTitle>
          {!createdKeyValue && (
            <DialogDescription>
              Create a virtual key linked to one of your provider API keys
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogForm onSubmit={handleCreate}>
          <div className="space-y-4 py-2">
            {createdKeyValue ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Key className="h-4 w-4" />
                  Copy this key now. It won&apos;t be shown again.
                </div>
                <CopyableCode value={createdKeyValue} />
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
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select an API key" />
                    </SelectTrigger>
                    <SelectContent>
                      {parentableKeys.map((key) => {
                        const config = PROVIDER_CONFIG[key.provider];
                        return (
                          <SelectItem key={key.id} value={key.id}>
                            <div className="flex items-center gap-2">
                              <Image
                                src={config.icon}
                                alt={config.name}
                                width={16}
                                height={16}
                                className="rounded dark:invert"
                              />
                              <span>{key.name}</span>
                              <Badge variant="outline" className="text-xs">
                                {config.name}
                              </Badge>
                            </div>
                          </SelectItem>
                        );
                      })}
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
                  <Label>
                    Expiration{" "}
                    <span className="text-muted-foreground font-normal">
                      ({Intl.DateTimeFormat().resolvedOptions().timeZone})
                    </span>
                  </Label>
                  <div className="flex items-center gap-2">
                    <DateTimePicker
                      value={expiresAt ?? undefined}
                      onChange={(date) => setExpiresAt(date ?? null)}
                      disabledDate={(date) => {
                        const today = new Date();
                        today.setHours(0, 0, 0, 0);
                        return date < today;
                      }}
                      placeholder="No expiration"
                      className="flex-1"
                    />
                    {expiresAt && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setExpiresAt(null)}
                      >
                        Never
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {expiresAt
                      ? `Expires ${formatExpiration(expiresAt)}`
                      : "Key will never expire"}
                  </p>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
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
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete Virtual Key</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete &quot;{virtualKey?.name}&quot;? This
            action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogForm
          onSubmit={() => {
            if (virtualKey) {
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
            }
          }}
        >
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

// --- Internal helpers ---

function formatExpiration(date: Date | string | null): string {
  if (!date) return "Never";
  const d = typeof date === "string" ? new Date(date) : date;
  if (d <= new Date()) return "Expired";
  return formatDistanceToNow(d, { addSuffix: true });
}

function computeDefaultExpiresAt(defaultSeconds: number | null): Date | null {
  if (!defaultSeconds) return null;
  return new Date(Date.now() + defaultSeconds * 1000);
}
