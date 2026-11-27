"use client";

import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DeletedItemsHint } from "@/components/deleted-items-hint";
import { ItemNames } from "@/components/item-names";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useDeletePlugins } from "@/lib/plugins/plugin.query";

/**
 * The one confirmation for deleting plugins. A row's delete button, the bulk
 * bar and the plugin's own page all open this dialog, so the question, the
 * text and the button are the same wherever a plugin is deleted. One plugin
 * and several differ only in the title's count.
 */
export function DeletePluginsDialog({
  plugins,
  open,
  onOpenChange,
  onDeleted,
}: {
  plugins: ReadonlyArray<{ id: string; displayName: string }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once at least one of the plugins is gone. */
  onDeleted?: () => void;
}) {
  const deletePlugins = useDeletePlugins();
  // The grant the deleted view of the plugins list asks for.
  const { data: canOpenDeletedView } = useHasPermissions(
    { plugin: ["update"] },
    "*",
  );

  return (
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        plugins.length === 1
          ? "Delete plugin?"
          : `Delete ${plugins.length} plugins?`
      }
      // The title asks the question; the text names what is deleted, says
      // what it leaves behind and where it comes back from. Two rows, spaced
      // as the skills delete dialog spaces its own.
      description={
        <>
          <span className="mt-2 block">
            <span>Installed copies of </span>
            <ItemNames
              items={plugins.map((plugin) => ({
                id: plugin.id,
                name: plugin.displayName,
              }))}
            />
            <span> stay on developer machines until you uninstall them.</span>
          </span>
          <span className="mt-3 block">
            <DeletedItemsHint
              nounPlural="plugins"
              listPath="/plugins"
              listName="Plugins"
              canOpenDeletedView={canOpenDeletedView === true}
              onNavigate={() => onOpenChange(false)}
            />
          </span>
        </>
      }
      isPending={deletePlugins.isPending}
      onConfirm={async () => {
        const { succeeded } = await deletePlugins.mutateAsync(
          plugins.map((plugin) => ({
            id: plugin.id,
            name: plugin.displayName,
          })),
        );
        // A plugin that could not be deleted keeps the dialog open, to retry.
        if (succeeded.length === 0) return;
        onDeleted?.();
        onOpenChange(false);
      }}
    />
  );
}
