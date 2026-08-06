"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Copy, Eye, EyeOff, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EditVirtualKeyDialog } from "@/components/edit-virtual-key-dialog";
import { formatProviderKeySummary } from "@/components/provider-key-mappings-field";
import { QueryLoadError } from "@/components/query-load-error";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { Button } from "@/components/ui/button";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { copyToClipboard } from "@/lib/clipboard";
import {
  useAllVirtualApiKeys,
  useDeleteVirtualApiKey,
  useFetchVirtualApiKeyValue,
} from "@/lib/virtual-api-keys.query";

type VirtualKeyRow =
  archestraApiTypes.GetAllVirtualApiKeysResponses["200"]["data"][number];

/** Compact management table for one type of LLM virtual key. */
export function VirtualKeyManagement({
  keyType,
}: {
  keyType: "standard" | "passthrough";
}) {
  const pageSize = 20;
  const [offset, setOffset] = useState(0);
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data: canRead } = useHasPermissions({ llmVirtualKey: ["read"] });
  const { data: canUpdate } = useHasPermissions({ llmVirtualKey: ["update"] });
  const { data: canDelete } = useHasPermissions({ llmVirtualKey: ["delete"] });
  const query = useAllVirtualApiKeys({
    keyType,
    limit: pageSize,
    offset,
    toastOnError: false,
    enabled: canRead === true,
  });
  const deleteMutation = useDeleteVirtualApiKey();
  const [editingKey, setEditingKey] = useState<VirtualKeyRow | null>(null);
  const [deletingKey, setDeletingKey] = useState<VirtualKeyRow | null>(null);

  useEffect(() => {
    if (query.data && offset > 0 && query.data.data.length === 0) {
      setOffset(Math.max(0, offset - pageSize));
    }
  }, [offset, query.data]);

  if (canRead === false) return null;
  if (query.isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load virtual keys"
        onRetry={() => query.refetch()}
      />
    );
  }
  const keys = query.data?.data ?? [];
  if (!query.isPending && keys.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {keyType === "passthrough"
          ? "No passthrough keys yet."
          : "No virtual keys yet. Create one and choose its provider key mappings."}
      </p>
    );
  }

  return (
    <div className="max-h-64 overflow-auto rounded-md border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b bg-muted/40 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-1.5 font-medium">Name</th>
            <th className="px-3 py-1.5 font-medium">Key</th>
            {keyType === "standard" && (
              <th className="px-3 py-1.5 font-medium">Providers</th>
            )}
            <th className="px-3 py-1.5 font-medium">Accessible to</th>
            {(canUpdate || canDelete) && <th className="w-8 px-2 py-1.5" />}
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key.id} className="border-b last:border-0">
              <td className="max-w-[150px] truncate px-3 py-1.5 font-medium">
                {key.name}
              </td>
              <td className="px-3 py-1.5">
                <VirtualKeyValueCell
                  id={key.id}
                  tokenStart={key.tokenStart}
                  canReveal={key.authorId === currentUserId}
                />
              </td>
              {keyType === "standard" && (
                <td className="max-w-[140px] truncate px-3 py-1.5 text-muted-foreground">
                  {formatProviderKeySummary(key.providerApiKeys)}
                </td>
              )}
              <td className="max-w-[180px] px-3 py-1.5">
                <ResourceVisibilityBadge
                  scope={key.scope}
                  teams={key.teams}
                  authorId={key.authorId}
                  authorName={key.authorName}
                  currentUserId={currentUserId}
                  showSelfAsMe
                />
              </td>
              {(canUpdate || canDelete) && (
                <td className="px-2 py-1.5">
                  <div className="flex items-center">
                    {canUpdate && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${key.name}`}
                        onClick={() => setEditingKey(key)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${key.name}`}
                        onClick={() => setDeletingKey(key)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    )}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {query.data && query.data.pagination.total > pageSize && (
        <div className="flex items-center justify-between border-t px-3 py-2">
          <span className="text-[11px] text-muted-foreground">
            {offset + 1}–
            {Math.min(offset + keys.length, query.data.pagination.total)} of{" "}
            {query.data.pagination.total}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!query.data.pagination.hasPrev}
              onClick={() => setOffset(Math.max(0, offset - pageSize))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!query.data.pagination.hasNext}
              onClick={() => setOffset(offset + pageSize)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
      <EditVirtualKeyDialog
        virtualKey={editingKey}
        onOpenChange={(open) => {
          if (!open) setEditingKey(null);
        }}
      />
      <DeleteConfirmDialog
        open={!!deletingKey}
        onOpenChange={(open) => {
          if (!open) setDeletingKey(null);
        }}
        title="Delete Virtual Key"
        description={`Are you sure you want to delete "${deletingKey?.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (!deletingKey) return;
          deleteMutation.mutate(
            { id: deletingKey.id },
            { onSuccess: () => setDeletingKey(null) },
          );
        }}
      />
    </div>
  );
}

function VirtualKeyValueCell({
  id,
  tokenStart,
  canReveal,
}: {
  id: string;
  tokenStart: string;
  canReveal: boolean;
}) {
  const fetchValue = useFetchVirtualApiKeyValue();
  const [value, setValue] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const resolveValue = async () => {
    if (value) return value;
    const fetched = await fetchValue.mutateAsync(id);
    if (fetched) setValue(fetched);
    return fetched;
  };
  return (
    <div className="flex items-center gap-1 font-mono">
      <code className={visible && value ? "break-all" : "whitespace-nowrap"}>
        {visible && value ? value : `${tokenStart}…`}
      </code>
      {canReveal && (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={visible ? "Hide key" : "Reveal key"}
            disabled={fetchValue.isPending}
            onClick={async () => {
              if (!visible && !(await resolveValue())) return;
              setVisible(!visible);
            }}
          >
            {visible ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Copy key"
            disabled={fetchValue.isPending}
            onClick={async () => {
              const resolved = await resolveValue();
              if (!resolved) return;
              await copyToClipboard(resolved);
              toast.success("Key copied");
            }}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}
