import { useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { GetInternalMcpCatalogResponses } from "@/lib/clients/api";
import { useUpdateInternalMcpCatalogItem } from "@/lib/internal-mcp-catalog.query";
import {
  McpCatalogForm,
  type McpCatalogFormValues,
  transformCatalogItemToFormValues,
  transformFormToApiData,
} from "./mcp-catalog-form";

interface EditCatalogDialogProps {
  item: GetInternalMcpCatalogResponses["200"][number] | null;
  onClose: () => void;
  onReinstallRequired: (
    catalogId: string,
    updatedData: { name?: string; serverUrl?: string },
  ) => void;
}

export function EditCatalogDialog({
  item,
  onClose,
  onReinstallRequired,
}: EditCatalogDialogProps) {
  const updateMutation = useUpdateInternalMcpCatalogItem();
  const submitButtonRef = useRef<HTMLButtonElement>(null);

  const handleClose = () => {
    onClose();
  };

  const requiresReinstall = (values: McpCatalogFormValues): boolean => {
    if (!item) return false;

    const originalValues = transformCatalogItemToFormValues(item);

    // Name, serverUrl, and authentication changes require reinstall
    if (values.name !== originalValues.name) return true;
    if (values.serverUrl !== originalValues.serverUrl) return true;
    if (values.authMethod !== originalValues.authMethod) return true;

    // Check OAuth config changes (deep comparison)
    if (
      JSON.stringify(values.oauthConfig) !==
      JSON.stringify(originalValues.oauthConfig)
    ) {
      return true;
    }

    return false;
  };

  const onSubmit = async (values: McpCatalogFormValues) => {
    if (!item) return;

    const apiData = transformFormToApiData(values);

    // Update the catalog item
    await updateMutation.mutateAsync({
      id: item.id,
      data: apiData,
    });

    const needsReinstall = requiresReinstall(values);

    // Close the edit dialog first
    handleClose();

    // Then notify parent about reinstall requirement with updated data
    if (needsReinstall) {
      onReinstallRequired(item.id, {
        name: values.name,
        serverUrl: values.serverUrl,
      });
    }
  };

  return (
    <Dialog open={!!item} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
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
            submitButtonRef={submitButtonRef}
          />
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} type="button">
            Cancel
          </Button>
          <Button
            onClick={() => submitButtonRef.current?.click()}
            disabled={updateMutation.isPending}
          >
            {updateMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
