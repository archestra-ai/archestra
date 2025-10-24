import { useState } from "react";
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
import { useCreateInternalMcpCatalogItem } from "@/lib/internal-mcp-catalog.query";

interface CreateCatalogDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CreateCatalogDialog({
  isOpen,
  onClose,
}: CreateCatalogDialogProps) {
  const [itemName, setItemName] = useState("");
  const [itemLabel, setItemLabel] = useState("");
  const createMutation = useCreateInternalMcpCatalogItem();

  const handleClose = () => {
    onClose();
    setItemName("");
    setItemLabel("");
  };

  const handleSubmit = async () => {
    await createMutation.mutateAsync({ name: itemName, label: itemLabel });
    handleClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create New Catalog Item</DialogTitle>
          <DialogDescription>
            Add a new MCP server to the catalog.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            value={itemName}
            onChange={(e) => setItemName(e.target.value)}
            placeholder="Enter server name"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="label">Label</Label>
          <Input
            id="label"
            value={itemLabel}
            onChange={(e) => setItemLabel(e.target.value)}
            placeholder="Enter display label (e.g., Asana MCP)"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!itemName.trim() || createMutation.isPending}
          >
            {createMutation.isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
