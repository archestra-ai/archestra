"use client";

import type { archestraApiTypes } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { Copy, Key, Loader2, Plus, Trash2 } from "lucide-react";
import Image from "next/image";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  type ChatApiKeyResponse,
  PROVIDER_CONFIG,
} from "@/components/chat-api-key-form";
import { LoadingWrapper } from "@/components/loading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { useFeatureValue } from "@/lib/features.hook";

type VirtualKeyWithParent =
  archestraApiTypes.GetAllVirtualApiKeysResponses["200"][number];

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

/**
 * Compute default expiration date from config seconds value.
 * Returns null (never expires) when defaultSeconds is 0 or unavailable.
 */
function computeDefaultExpiresAt(defaultSeconds: number | null): Date | null {
  if (!defaultSeconds) return null;
  return new Date(Date.now() + defaultSeconds * 1000);
}

/**
 * Format a Date to a datetime-local input value (YYYY-MM-DDTHH:mm).
 */
function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function ProviderSettingsVirtualKeys() {
  const { data: virtualKeys = [], isPending } = useAllVirtualApiKeys();
  const { data: apiKeys = [] } = useChatApiKeys();
  const createMutation = useCreateVirtualApiKey();
  const deleteMutation = useDeleteVirtualApiKey();
  const defaultExpirationSeconds = useFeatureValue(
    "virtualKeyDefaultExpirationSeconds",
  );

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [createdKeyValue, setCreatedKeyValue] = useState<string | null>(null);
  const [createdKeyExpiresAt, setCreatedKeyExpiresAt] = useState<Date | null>(
    null,
  );
  const [newKeyName, setNewKeyName] = useState("");
  const [selectedParentKeyId, setSelectedParentKeyId] = useState<string>("");
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);

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

  const handleCopy = useCallback(() => {
    if (createdKeyValue) {
      navigator.clipboard.writeText(createdKeyValue);
      toast.success("Copied to clipboard");
    }
  }, [createdKeyValue]);

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
            onClick={() =>
              deleteMutation.mutate({
                chatApiKeyId: row.original.chatApiKeyId,
                id: row.original.id,
              })
            }
            disabled={deleteMutation.isPending}
          >
            <Trash2 className="h-3 w-3 text-destructive" />
          </Button>
        ),
      },
    ],
    [deleteMutation],
  );

  // Non-system API keys that can have virtual keys
  const parentableKeys = apiKeys.filter((k) => !k.isSystem);

  return (
    <LoadingWrapper
      isPending={isPending}
      loadingFallback={
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      }
    >
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <div>
            <h2 className="text-lg font-semibold">Virtual API Keys</h2>
            <p className="text-sm text-muted-foreground">
              Virtual keys let external clients use your provider keys via the
              LLM Proxy without exposing the real API key
            </p>
          </div>
          <Button
            onClick={() => {
              setCreatedKeyValue(null);
              setCreatedKeyExpiresAt(null);
              setNewKeyName("");
              setSelectedParentKeyId(parentableKeys[0]?.id ?? "");
              setExpiresAt(computeDefaultExpiresAt(defaultExpirationSeconds));
              setIsCreateDialogOpen(true);
            }}
            disabled={parentableKeys.length === 0}
          >
            <Plus className="h-4 w-4 mr-2" />
            Create Virtual Key
          </Button>
        </div>

        {parentableKeys.length === 0 && (
          <div className="text-center py-8 text-muted-foreground">
            <p>
              <a
                href="/llm-proxies/provider-settings"
                className="underline hover:text-foreground"
              >
                Add an API key
              </a>{" "}
              first to create virtual keys.
            </p>
          </div>
        )}

        {virtualKeys.length > 0 && (
          <DataTable
            columns={columns}
            data={virtualKeys}
            getRowId={(row) => row.id}
            hideSelectedCount
          />
        )}

        {virtualKeys.length === 0 && parentableKeys.length > 0 && (
          <div className="text-center py-8 text-muted-foreground">
            <p>
              No virtual keys yet. Create one to let external clients use your
              provider keys securely.
            </p>
          </div>
        )}

        <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
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
            <div className="space-y-4 py-2">
              {createdKeyValue ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Key className="h-4 w-4" />
                    Copy this key now. It won&apos;t be shown again.
                  </div>
                  <div className="flex items-center gap-2 bg-muted rounded px-3 py-2">
                    <code className="text-xs break-all flex-1 min-w-0">
                      {createdKeyValue}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0"
                      onClick={handleCopy}
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">
                      Expires:
                    </span>{" "}
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
                    <Label>Name</Label>
                    <Input
                      value={newKeyName}
                      onChange={(e) => setNewKeyName(e.target.value)}
                      placeholder="My virtual key"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleCreate();
                        }
                      }}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Expiration</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="datetime-local"
                        value={expiresAt ? toDatetimeLocalValue(expiresAt) : ""}
                        min={toDatetimeLocalValue(new Date())}
                        onChange={(e) =>
                          setExpiresAt(
                            e.target.value ? new Date(e.target.value) : null,
                          )
                        }
                        className="flex-1"
                      />
                      {expiresAt && (
                        <Button
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
                variant="outline"
                onClick={() => setIsCreateDialogOpen(false)}
              >
                {createdKeyValue ? "Close" : "Cancel"}
              </Button>
              {!createdKeyValue && (
                <Button
                  onClick={handleCreate}
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
          </DialogContent>
        </Dialog>
      </div>
    </LoadingWrapper>
  );
}
