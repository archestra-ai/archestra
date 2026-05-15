import type { archestraApiTypes } from "@shared";
import { useState } from "react";
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
import { CascadeReinstallConfirmDialog } from "./cascade-reinstall-confirm-dialog";
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
  const [pendingValues, setPendingValues] =
    useState<McpCatalogFormValues | null>(null);
  const updateMutation = useUpdateInternalMcpCatalogItem();

  const { data: presets = [] } = useCatalogPresets(item.id);
  const { data: servers = [] } = useMcpServers();
  const affectedCatalogIds = new Set([item.id, ...presets.map((p) => p.id)]);
  const affectedServerCount = servers.filter((s) =>
    s.catalogId ? affectedCatalogIds.has(s.catalogId) : false,
  ).length;

  const performSave = async (values: McpCatalogFormValues) => {
    const apiData = transformFormToApiData(values);
    const { multitenant: _multitenant, ...updateData } = apiData;

    await updateMutation.mutateAsync({
      id: item.id,
      data: updateData,
    });

    if (!keepOpenOnSave) {
      onClose();
    }
  };

  const onSubmit = async (values: McpCatalogFormValues) => {
    if (affectedServerCount > 0) {
      setPendingValues(values);
      return;
    }
    await performSave(values);
  };

  return (
    <>
      <McpCatalogForm
        mode="edit"
        initialValues={item}
        onSubmit={onSubmit}
        embedded={keepOpenOnSave}
        nameDisabled
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

      <CascadeReinstallConfirmDialog
        open={pendingValues !== null}
        onOpenChange={(v) => !v && setPendingValues(null)}
        onConfirm={async () => {
          if (!pendingValues) return;
          const values = pendingValues;
          setPendingValues(null);
          await performSave(values);
        }}
        isPending={updateMutation.isPending}
        serverCount={affectedServerCount}
        presetCount={presets.length}
      />
    </>
  );
}
