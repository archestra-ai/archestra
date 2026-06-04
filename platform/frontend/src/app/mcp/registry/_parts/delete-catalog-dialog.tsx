import type { archestraApiTypes } from "@shared";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { useDeleteInternalMcpCatalogItem } from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpServers } from "@/lib/mcp/mcp-server.query";

interface DeleteCatalogDialogProps {
  item: archestraApiTypes.GetInternalMcpCatalogResponses["200"][number] | null;
  onClose: () => void;
  /** Called only after a successful deletion (before onClose). */
  onDeleted?: () => void;
}

export function DeleteCatalogDialog({
  item,
  onClose,
  onDeleted,
}: DeleteCatalogDialogProps) {
  const deleteMutation = useDeleteInternalMcpCatalogItem();
  const { data: installedServers = [] } = useMcpServers();

  const handleConfirm = async () => {
    if (!item) return;
    await deleteMutation.mutateAsync(item.id);
    onDeleted?.();
    onClose();
  };

  // Deleting a catalog item uninstalls every server installed from it.
  const installationCount = item
    ? installedServers.filter((s) => s.catalogId === item.id).length
    : 0;

  const question = item ? (
    <p>
      Are you sure you want to delete{" "}
      <span className="font-semibold break-all">"{item.name}"</span>?
    </p>
  ) : null;

  return (
    <DeleteConfirmDialog
      open={!!item}
      onOpenChange={() => onClose()}
      title="Delete Catalog Item"
      description={
        item ? (
          installationCount > 0 ? (
            <div className="space-y-2">
              {question}
              <p className="text-sm text-muted-foreground">
                There are currently <strong>{installationCount}</strong>{" "}
                {installationCount === 1 ? "installation" : "installations"} of
                this server. Deleting this catalog item will uninstall all of
                them.
              </p>
            </div>
          ) : (
            question
          )
        ) : (
          ""
        )
      }
      isPending={deleteMutation.isPending}
      onConfirm={handleConfirm}
    />
  );
}
