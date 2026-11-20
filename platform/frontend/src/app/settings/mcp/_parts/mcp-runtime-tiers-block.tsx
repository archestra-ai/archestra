import { formatMemory, type McpRuntimeTierSize } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { QueryLoadError } from "@/components/query-load-error";
import { SettingsBlock } from "@/components/settings/settings-block";
import { TableRowActions } from "@/components/table-row-actions";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  useMcpRuntimeTiers,
  useSaveMcpRuntimeTiers,
} from "@/lib/organization.query";
import { McpRuntimeTierDialog } from "./mcp-runtime-tier-dialog";
import { mcpRuntimeTierInput } from "./mcp-runtime-tier-form";

/**
 * The organization's runtime tiers: a table of the tiers in effect and dialogs
 * that create, edit or delete one. Each dialog saves at once.
 */
export function McpRuntimeTiersBlock({ canEdit }: { canEdit: boolean }) {
  const {
    data: resolved,
    isPending,
    isError,
    error,
    refetch,
  } = useMcpRuntimeTiers();
  const save = useSaveMcpRuntimeTiers();
  // Keep the selected tier through the exit animation so validation and the
  // title do not switch to creation mode while the dialog is still visible.
  const [editing, setEditing] = useState<{
    tier: McpRuntimeTierSize | null;
    open: boolean;
  } | null>(null);
  const [deleting, setDeleting] = useState<McpRuntimeTierSize | null>(null);
  const [deleteFailure, setDeleteFailure] = useState<string | null>(null);

  const tiers = resolved?.tiers ?? [];

  const columns: ColumnDef<McpRuntimeTierSize>[] = [
    {
      id: "name",
      accessorKey: "name",
      header: "Tier",
      size: 150,
      minSize: 120,
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          <span className="font-medium">{row.original.name}</span>
        </span>
      ),
    },
    {
      id: "cpuRequest",
      accessorKey: "cpuRequest",
      header: "CPU",
      size: 72,
      cell: ({ row }) => (
        <span className="tabular-nums">{row.original.cpuRequest}</span>
      ),
    },
    {
      id: "cpuLimit",
      accessorFn: (row) => row.cpuLimit ?? Number.POSITIVE_INFINITY,
      header: "CPU limit",
      size: 96,
      cell: ({ row }) =>
        row.original.cpuLimit === null ? (
          <span className="text-muted-foreground">No limit</span>
        ) : (
          <span className="tabular-nums">{row.original.cpuLimit}</span>
        ),
    },
    {
      id: "memory",
      accessorKey: "memoryRequestMiB",
      header: "Memory",
      size: 110,
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatMemory(row.original.memoryRequestMiB)}
          <span className="block text-xs text-muted-foreground">
            {formatMemory(row.original.memoryLimitMiB)} limit
          </span>
        </span>
      ),
    },
    ...(canEdit
      ? [
          {
            id: "actions",
            header: "Actions",
            size: 96,
            enableSorting: false,
            enableHiding: false,
            cell: ({ row }) => {
              const tier = row.original;
              return (
                <TableRowActions
                  itemName={tier.name}
                  actions={[
                    {
                      icon: <Pencil className="h-4 w-4" />,
                      label: "Edit",
                      onClick: () => setEditing({ tier, open: true }),
                    },
                    {
                      icon: <Trash2 className="h-4 w-4" />,
                      label: "Delete",
                      variant: "destructive",
                      disabled: tiers.length === 1,
                      disabledTooltip: "Keep at least one tier",
                      onClick: () => {
                        setDeleteFailure(null);
                        setDeleting(tier);
                      },
                    },
                  ]}
                />
              );
            },
          } satisfies ColumnDef<McpRuntimeTierSize>,
        ]
      : []),
  ];

  const closeDelete = () => {
    setDeleting(null);
    setDeleteFailure(null);
  };
  const confirmDelete = async () => {
    if (!deleting || !resolved) return;
    try {
      await save.mutateAsync({
        tiers: tiers
          .filter((tier) => tier.name !== deleting.name)
          .map(mcpRuntimeTierInput),
      });
      closeDelete();
    } catch (error) {
      setDeleteFailure(
        error instanceof Error && error.message
          ? error.message
          : "The tier could not be deleted",
      );
    }
  };

  if (isError)
    return (
      <QueryLoadError
        title="Could not load MCP runtime tiers"
        error={error}
        onRetry={() => void refetch()}
      />
    );

  return (
    <SettingsBlock
      id="runtime-tiers"
      title="Runtime tiers"
      description="CPU and memory tiers for self-hosted MCP servers. Changes require affected MCP servers to be reinstalled."
      control={
        canEdit && resolved ? (
          <Button
            size="sm"
            onClick={() => setEditing({ tier: null, open: true })}
          >
            <Plus className="h-4 w-4" />
            <span>Create tier</span>
          </Button>
        ) : undefined
      }
      notice={
        canEdit ? undefined : (
          <span className="text-muted-foreground">
            Only administrators can change the tiers.
          </span>
        )
      }
    >
      <DataTable
        columns={columns}
        data={tiers}
        getRowId={(row) => row.name}
        isLoading={isPending}
        hidePaginationWhenSinglePage
        emptyMessage="No tiers"
        columnDropOrder={["memory", "cpuLimit"]}
      />
      {resolved && (
        <McpRuntimeTierDialog
          open={editing?.open ?? false}
          onOpenChange={(open) => {
            setEditing((current) => current && { ...current, open });
          }}
          tier={editing?.tier ?? null}
          tiers={resolved}
          onSave={async (settings) => {
            await save.mutateAsync(settings);
            setEditing((current) => current && { ...current, open: false });
          }}
        />
      )}
      <DeleteConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) closeDelete();
        }}
        title={`Delete tier ${deleting?.name ?? ""}?`}
        description={
          <>
            MCP servers that use this tier must move to another tier or
            deployment defaults first. The tier cannot be deleted while it is in
            use.
            {deleteFailure && (
              <span role="alert" className="mt-2 block text-destructive">
                {deleteFailure}
              </span>
            )}
          </>
        }
        isPending={save.isPending}
        onConfirm={() => {
          void confirmDelete();
        }}
        confirmLabel="Delete tier"
        pendingLabel="Deleting…"
      />
    </SettingsBlock>
  );
}
