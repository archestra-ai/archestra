import type { archestraApiTypes } from "@shared";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  useCatalogPresets,
  useDeleteInternalMcpCatalogItem,
} from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpServers } from "@/lib/mcp/mcp-server.query";
import { usePresetEntityName } from "@/lib/organization.query";

interface DeleteCatalogDialogProps {
  item: archestraApiTypes.GetInternalMcpCatalogResponses["200"][number] | null;
  onClose: () => void;
  /** Called only after a successful deletion (before onClose). */
  onDeleted?: () => void;
}

export function DeleteCatalogDialog({
  item,
  onClose,
  onDeleted,
}: DeleteCatalogDialogProps) {
  const deleteMutation = useDeleteInternalMcpCatalogItem();
  const { data: presets = [] } = useCatalogPresets(item?.id ?? null);
  const { data: installedServers = [] } = useMcpServers();
  const { singular, plural } = usePresetEntityName();

  const handleConfirm = async () => {
    if (!item) return;
    await deleteMutation.mutateAsync(item.id);
    onDeleted?.();
    onClose();
  };

  // Deleting a parent catalog item cascade-deletes its child presets and
  // uninstalls every server across the parent and the children. Count all of
  // them, plus how many distinct envs (parent + presets) actually hold installs.
  const envCatalogIds = item ? [item.id, ...presets.map((p) => p.id)] : [];
  const relevantInstalls = installedServers.filter((s) =>
    envCatalogIds.includes(s.catalogId),
  );
  const installationCount = relevantInstalls.length;
  const envsWithInstalls = new Set(relevantInstalls.map((s) => s.catalogId))
    .size;

  const envTerm = envsWithInstalls === 1 ? singular : plural;
  const showEnvBreakdown = presets.length > 0 && envsWithInstalls > 0;

  const question = item ? (
    <p>
      Are you sure you want to delete{" "}
      <span className="font-semibold break-all">"{item.name}"</span>?
    </p>
  ) : null;

  return (
    <DeleteConfirmDialog
      open={!!item}
      onOpenChange={() => onClose()}
      title="Delete Catalog Item"
      description={
        item ? (
          installationCount > 0 ? (
            <div className="space-y-2">
              {question}
              <p className="text-sm text-muted-foreground">
                There are currently <strong>{installationCount}</strong>{" "}
                {installationCount === 1 ? "installation" : "installations"} of
                this server
                {showEnvBreakdown ? (
                  <>
                    {" "}
                    across <strong>{envsWithInstalls}</strong>{" "}
                    {envTerm.toLowerCase()}
                  </>
                ) : null}
                . Deleting this catalog item will uninstall all of them.
              </p>
            </div>
          ) : (
            question
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
