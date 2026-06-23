import type { archestraApiTypes } from "@archestra/shared";
import { Loader2, ShieldX } from "lucide-react";
import type { UseFormReturn } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { DialogFooter, DialogStickyFooter } from "@/components/ui/dialog";
import {
  getCatalogMutationErrorCode,
  REMOTE_SERVER_URL_NOT_ALLOWED_CODE,
  useUpdateInternalMcpCatalogItem,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpServers } from "@/lib/mcp/mcp-server.query";
import { useCanModifyCatalogItem } from "../../_parts/catalog-edit-access";
import { McpCatalogForm } from "../../_parts/mcp-catalog-form";
import type { McpCatalogFormValues } from "../../_parts/mcp-catalog-form.types";
import { transformFormToApiData } from "../../_parts/mcp-catalog-form.utils";

interface EditCatalogDialogProps {
  item: archestraApiTypes.GetInternalMcpCatalogResponses["200"][number] | null;
  onClose: () => void;
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
  /**
   * Replaces the default Discard/Save footer. Rendered inside the form, so a
   * `type="submit"` button triggers the save. Used by the setup wizard to keep
   * a single primary CTA per step.
   */
  footer?: (ctx: {
    isDirty: boolean;
    isSaving: boolean;
    hasBlockingErrors: boolean;
    onReset: () => void;
  }) => React.ReactNode;
}

export function EditCatalogContent({
  item,
  onClose,
  keepOpenOnSave = false,
  onDirtyChange,
  submitRef,
  footer,
}: EditCatalogContentProps) {
  // Authorization gate for the edit form itself — covers every entry point
  // (the settings dialog's Configuration page, a shared `?edit=<id>` deep link,
  // or the legacy EditCatalogDialog). Mirrors the backend item-modify rule: an
  // admin, a team-admin member of the item's teams, or the author of a personal
  // item.
  const { canModify: canEdit, isLoading: canEditLoading } =
    useCanModifyCatalogItem(item);
  const updateMutation = useUpdateInternalMcpCatalogItem();

  const { data: servers = [] } = useMcpServers();
  const affectedServerCount = servers.filter(
    (s) => s.catalogId === item.id,
  ).length;

  const onSubmit = (
    values: McpCatalogFormValues,
    form: UseFormReturn<McpCatalogFormValues>,
  ) => {
    const { multitenant: _multitenant, ...updateData } =
      transformFormToApiData(values);

    // Callback form so the dialog only closes on success; on a validation
    // error it stays open for correction.
    updateMutation.mutate(
      { id: item.id, data: updateData },
      {
        onSuccess: () => {
          if (!keepOpenOnSave) {
            onClose();
          }
        },
        onError: (error) => {
          // Network-policy rejections point at the Server URL — show them
          // inline on that field rather than as a toast.
          if (
            getCatalogMutationErrorCode(error) ===
            REMOTE_SERVER_URL_NOT_ALLOWED_CODE
          ) {
            form.setError("serverUrl", {
              type: "server",
              message:
                error instanceof Error
                  ? error.message
                  : "Server URL is not allowed by the environment's network policy.",
            });
          }
        },
      },
    );
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
      footer={({ isDirty, onReset, hasBlockingErrors }) => {
        if (footer) {
          return footer({
            isDirty,
            isSaving: updateMutation.isPending,
            hasBlockingErrors,
            onReset,
          });
        }
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
              disabled={
                updateMutation.isPending || !isDirty || hasBlockingErrors
              }
            >
              {updateMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </Footer>
        );
      }}
    />
  );
}
