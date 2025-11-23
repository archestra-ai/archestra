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
import { useUpdateInternalMcpCatalogItem } from "@/lib/internal-mcp-catalog.query";
import { McpCatalogForm } from "./mcp-catalog-form";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";
import { transformFormToApiData } from "./mcp-catalog-form.utils";

interface EditCatalogDialogProps {
  item: archestraApiTypes.GetInternalMcpCatalogResponses["200"][number] | null;
  onClose: () => void;
}

export function EditCatalogDialog({ item, onClose }: EditCatalogDialogProps) {
  const updateMutation = useUpdateInternalMcpCatalogItem();

  const handleClose = () => {
    onClose();
  };

  const onSubmit = async (values: McpCatalogFormValues) => {
    if (!item) return;

    const apiData = transformFormToApiData(values);

    // Update the catalog item
    await updateMutation.mutateAsync({
      id: item.id,
      data: apiData,
    });

    // Close the edit dialog
    handleClose();

    // Note: The backend sets reinstallRequired flag on all installations when critical fields change
    // Users will see "Reinstall Required" button on their installed servers automatically
  };

  return (
    <Dialog open={!!item} onOpenChange={handleClose}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit MCP Server</DialogTitle>
          <DialogDescription>
            Update the configuration for this MCP server.
          </DialogDescription>
        </DialogHeader>

        {item && (
          <McpCatalogForm
            mode="edit"
            initialValues={item}
            onSubmit={onSubmit}
            footer={
              <DialogFooter>
                <Button variant="outline" onClick={handleClose} type="button">
                  Cancel
                </Button>
                <Button type="submit" disabled={updateMutation.isPending}>
                  {updateMutation.isPending ? "Saving..." : "Save Changes"}
                </Button>
              </DialogFooter>
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
