import type { archestraApiTypes } from "@shared";
import { Loader2, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import {
  useCatalogPresets,
  useUpdateInternalMcpCatalogItem,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpServers } from "@/lib/mcp/mcp-server.query";
import { McpCatalogForm } from "./mcp-catalog-form";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";
import { transformFormToApiData } from "./mcp-catalog-form.utils";
import { useCanEditCatalogPresets } from "./preset-helpers";

interface EditCatalogDialogProps {
  item: archestraApiTypes.GetInternalMcpCatalogResponses["200"][number] | null;
  onClose: () => void;
}

export function EditCatalogDialog({ item, onClose }: EditCatalogDialogProps) {
  return (
    <Dialog open={!!item} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl h-[85vh] flex flex-col overflow-hidden">
        {item && <EditCatalogContent item={item} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

/** Centered spinner while the edit-permission check resolves. */
function CatalogEditLoading() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

/**
 * Access-denied body shown in place of the edit form. Plain content (no
 * DialogHeader) so it can be dropped inside any dialog that already provides a
 * title — the settings dialog's Configuration page, or the standalone
 * deep-link dialog on the catalog card.
 */
export function CatalogEditNoAccess() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
      <ShieldX className="h-10 w-10" />
      <p className="text-sm">
        You don't have access to edit this catalog item.
      </p>
    </div>
  );
}

interface EditCatalogContentProps {
  item: NonNullable<EditCatalogDialogProps["item"]>;
  onClose: () => void;
  /** When true, save does not close the dialog */
  keepOpenOnSave?: boolean;
  /** Called when form dirty state changes */
  onDirtyChange?: (isDirty: boolean) => void;
  /** Ref to imperatively trigger form submission */
  submitRef?: React.MutableRefObject<(() => Promise<void>) | null>;
}

export function EditCatalogContent({
  item,
  onClose,
  keepOpenOnSave = false,
  onDirtyChange,
  submitRef,
}: EditCatalogContentProps) {
  // Authorization gate for the edit form itself — covers every entry point
  // (the settings dialog's Configuration page, a shared `?edit=<id>` deep link,
  // or the legacy EditCatalogDialog). Mirrors the backend
  // `assertCanEditCatalogPresets`: an admin, or the author of a personal item.
  const { canEdit, isLoading: canEditLoading } = useCanEditCatalogPresets(item);
  const updateMutation = useUpdateInternalMcpCatalogItem();

  const { data: presets = [] } = useCatalogPresets(item.id);
  const { data: servers = [] } = useMcpServers();
  const affectedCatalogIds = new Set([item.id, ...presets.map((p) => p.id)]);
  const affectedServerCount = servers.filter((s) =>
    s.catalogId ? affectedCatalogIds.has(s.catalogId) : false,
  ).length;

  const onSubmit = async (values: McpCatalogFormValues) => {
    const { multitenant: _multitenant, ...updateData } =
      transformFormToApiData(values);

    await updateMutation.mutateAsync({
      id: item.id,
      data: updateData,
    });

    if (!keepOpenOnSave) {
      onClose();
    }
  };

  if (canEditLoading) {
    return <CatalogEditLoading />;
  }
  if (!canEdit) {
    return <CatalogEditNoAccess />;
  }

  return (
    <McpCatalogForm
      mode="edit"
      initialValues={item}
      onSubmit={onSubmit}
      embedded={keepOpenOnSave}
      nameDisabled
      onDirtyChange={onDirtyChange}
      submitRef={submitRef}
      affectedServerCount={affectedServerCount}
      footer={({ isDirty, onReset }) => {
        if (keepOpenOnSave && !isDirty) return null;
        const Footer = keepOpenOnSave ? DialogStickyFooter : DialogFooter;
        return (
          <Footer className={keepOpenOnSave ? "mt-0" : undefined}>
            {keepOpenOnSave ? (
              <Button variant="outline" onClick={onReset} type="button">
                Discard changes
              </Button>
            ) : (
              <Button variant="outline" onClick={onClose} type="button">
                Cancel
              </Button>
            )}
            <Button
              type="submit"
              disabled={updateMutation.isPending || !isDirty}
            >
              {updateMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </Footer>
        );
      }}
    />
  );
}
