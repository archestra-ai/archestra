import { type archestraApiTypes, isPlaywrightCatalogItem } from "@shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogStickyFooter,
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
  return (
    <Dialog open={!!item} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl h-[85vh] flex flex-col overflow-hidden">
        {item && <EditCatalogContent item={item} onClose={onClose} />}
      </DialogContent>
    </Dialog>
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
  const updateMutation = useUpdateInternalMcpCatalogItem();

  const onSubmit = async (values: McpCatalogFormValues) => {
    const apiData = transformFormToApiData(values);

    await updateMutation.mutateAsync({
      id: item.id,
      data: apiData,
    });

    if (!keepOpenOnSave) {
      onClose();
    }
  };

  return (
    <McpCatalogForm
      mode="edit"
      initialValues={item}
      onSubmit={onSubmit}
      embedded={keepOpenOnSave}
      nameDisabled={isPlaywrightCatalogItem(item.id)}
      onDirtyChange={onDirtyChange}
      submitRef={submitRef}
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
