"use client";

import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
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

  return (
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        plugins.length === 1
          ? "Delete plugin?"
          : `Delete ${plugins.length} plugins?`
      }
      // The title asks the question; the text says what it leaves behind.
      description="Installed copies stay on developer machines until you uninstall them."
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
