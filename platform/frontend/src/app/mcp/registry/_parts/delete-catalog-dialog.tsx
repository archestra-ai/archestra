import type { archestraApiTypes } from "@shared";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { useDeleteInternalMcpCatalogItem } from "@/lib/internal-mcp-catalog.query";

interface DeleteCatalogDialogProps {
  item: archestraApiTypes.GetInternalMcpCatalogResponses["200"][number] | null;
  onClose: () => void;
  installationCount: number;
}

export function DeleteCatalogDialog({
  item,
  onClose,
  installationCount,
}: DeleteCatalogDialogProps) {
  const deleteMutation = useDeleteInternalMcpCatalogItem();

  const handleConfirm = async () => {
    if (!item) return;
    await deleteMutation.mutateAsync(item.id);
    onClose();
  };

  const ConfirmationContent = ({ name }: { name: string }) => (
    <span>
      Are you sure you want to delete{" "}
      <span className="font-semibold break-all">"{name}"</span>?
    </span>
  );

  return (
    <DeleteConfirmDialog
      open={!!item}
      onOpenChange={() => onClose()}
      title="Delete Catalog Item"
      description={
        item ? (
          installationCount > 0 ? (
            <span className="block space-y-3">
              <ConfirmationContent name={item.name} />
              <span className="block text-sm">
                There are currently <strong>{installationCount}</strong>{" "}
                installation(s) of this server. Deleting this catalog entry will
                also uninstall all associated servers.
              </span>
            </span>
          ) : (
            <ConfirmationContent name={item.name} />
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
