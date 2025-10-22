import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
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
import type { GetMcpCatalogResponses } from "@/lib/clients/api";
import { useUpdateMcpCatalogItem } from "@/lib/mcp-catalog.query";

interface EditCatalogDialogProps {
  item: GetMcpCatalogResponses["200"][number] | null;
  onClose: () => void;
}

export function EditCatalogDialog({ item, onClose }: EditCatalogDialogProps) {
  const [itemName, setItemName] = useState("");
  const updateMutation = useUpdateMcpCatalogItem();

  // Sync item name when item changes
  useEffect(() => {
    if (item) {
      setItemName(item.name);
    }
  }, [item]);

  const handleClose = () => {
    onClose();
    setItemName("");
  };

  const handleSubmit = async () => {
    if (!item) return;
    await updateMutation.mutateAsync({
      id: item.id,
      data: { name: itemName },
    });
    handleClose();
  };

  return (
    <Dialog open={!!item} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit Catalog Item</DialogTitle>
          <DialogDescription>Update the catalog item name.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="edit-name">Name</Label>
          <Input
            id="edit-name"
            value={itemName}
            onChange={(e) => setItemName(e.target.value)}
            placeholder="Enter server name"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!itemName.trim() || updateMutation.isPending}
          >
            {updateMutation.isPending ? "Updating..." : "Update"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
