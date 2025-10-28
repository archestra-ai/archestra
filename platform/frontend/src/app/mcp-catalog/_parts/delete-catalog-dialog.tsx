import type { archestraApiTypes } from "@shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

  return (
    <Dialog open={!!item} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete Catalog Item</DialogTitle>
          <DialogDescription>
            {item &&
              (() => {
                return installationCount > 0 ? (
                  <span>
                    Are you sure you want to delete "{item.name}"? There are
                    currently <strong>{installationCount}</strong>{" "}
                    installation(s) of this server. Deleting this catalog entry
                    will also uninstall all associated servers.
                  </span>
                ) : (
                  `Are you sure you want to delete "${item.name}"?`
                );
              })()}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
