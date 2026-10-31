import { DocsPage, formatMemory, getDocsUrl } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { SettingsBlock } from "@/components/settings/settings-block";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  useAgentRuntimeTiers,
  useSaveAgentRuntimeTiers,
} from "@/lib/organization.query";
import { RuntimeTierDialog } from "./runtime-tier-dialog";
import {
  type RuntimeTierSize,
  runtimeTierSettingsAfter,
} from "./runtime-tier-form";

/**
 * The organization's runtime tiers: a table of the tiers in effect and dialogs
 * that create, edit or delete one. Each dialog saves at once.
 */
export function RuntimeTiersBlock({ canEdit }: { canEdit: boolean }) {
  const { data: resolved, isPending } = useAgentRuntimeTiers();
  const save = useSaveAgentRuntimeTiers();
  // Open dialogs: `editing` holds the tier being edited, or null for a new one.
  const [editing, setEditing] = useState<{
    tier: RuntimeTierSize | null;
  } | null>(null);
  const [deleting, setDeleting] = useState<RuntimeTierSize | null>(null);
  const [deleteFailure, setDeleteFailure] = useState<string | null>(null);

  const tiers = resolved?.tiers ?? [];
  const defaultTier = resolved?.defaultTier;
  const defaultWorkspaceGiB = resolved?.defaultWorkspaceGiB;

  const columns: ColumnDef<RuntimeTierSize>[] = [
    {
      id: "name",
      accessorKey: "name",
      header: "Tier",
      size: 150,
      minSize: 120,
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          <span className="font-medium">{row.original.name}</span>
          {defaultTier !== undefined &&
            row.original.name.toLowerCase() === defaultTier.toLowerCase() && (
              <Badge variant="secondary">Default</Badge>
            )}
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
    {
      id: "workspace",
      accessorFn: (row) => row.workspaceGiB ?? defaultWorkspaceGiB ?? 0,
      header: "Workspace",
      size: 110,
      cell: ({ row }) =>
        row.original.workspaceGiB === null ? (
          <span className="tabular-nums">
            {defaultWorkspaceGiB} GiB
            <span className="block text-xs text-muted-foreground">
              default
            </span>
          </span>
        ) : (
          <span className="tabular-nums">{row.original.workspaceGiB} GiB</span>
        ),
    },
    {
      id: "pools",
      accessorKey: "pooled",
      header: "Pools",
      size: 76,
      cell: ({ row }) =>
        row.original.pooled ? (
          "Pooled"
        ) : (
          <span className="text-muted-foreground">No</span>
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
              const isDefault =
                defaultTier !== undefined &&
                tier.name.toLowerCase() === defaultTier.toLowerCase();
              return (
                <TableRowActions
                  itemName={tier.name}
                  actions={[
                    {
                      icon: <Pencil className="h-4 w-4" />,
                      label: "Edit",
                      onClick: () => setEditing({ tier }),
                    },
                    {
                      icon: <Trash2 className="h-4 w-4" />,
                      label: "Delete",
                      variant: "destructive",
                      disabled: tiers.length === 1 || isDefault,
                      disabledTooltip:
                        tiers.length === 1
                          ? "Keep at least one tier"
                          : "Make another tier the default first",
                      onClick: () => {
                        setDeleteFailure(null);
                        setDeleting(tier);
                      },
                    },
                  ]}
                />
              );
            },
          } satisfies ColumnDef<RuntimeTierSize>,
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
      await save.mutateAsync(
        runtimeTierSettingsAfter(resolved, {
          kind: "delete",
          name: deleting.name,
        }),
      );
      toast.success(`Tier ${deleting.name} deleted`);
      closeDelete();
    } catch (error) {
      setDeleteFailure(
        error instanceof Error && error.message
          ? error.message
          : "The tier could not be deleted",
      );
    }
  };

  return (
    <SettingsBlock
      id="runtime-tiers"
      title="Runtime tiers"
      description={
        <>
          Runtime tiers control compute and other resources allocation to agent
          runtimes.{" "}
          <ExternalDocsLink
            href={getDocsUrl(
              DocsPage.PlatformAgentRuntimeSetup,
              "runtime-tiers",
            )}
            className="whitespace-nowrap"
          >
            Learn more
          </ExternalDocsLink>
        </>
      }
      control={
        canEdit ? (
          <Button size="sm" onClick={() => setEditing({ tier: null })}>
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
        columnDropOrder={["memory", "workspace", "cpuLimit", "pools"]}
      />
      {resolved && (
        <RuntimeTierDialog
          open={editing !== null}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          tier={editing?.tier ?? null}
          tiers={resolved}
          onSave={async (settings) => {
            await save.mutateAsync(settings);
            toast.success(editing?.tier ? "Tier saved" : "Tier created");
            setEditing(null);
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
            Agents and templates that name it as their default or scaleup tier
            must move to another tier first; the deletion is refused while any
            does.
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
