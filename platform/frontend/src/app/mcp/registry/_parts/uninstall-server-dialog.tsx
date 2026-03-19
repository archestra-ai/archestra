"use client";

import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { useDeleteMcpServer } from "@/lib/mcp-server.query";

interface UninstallServerDialogProps {
  server: { id: string; name: string } | null;
  onClose: () => void;
  isCancelingInstallation?: boolean;
  onCancelInstallation?: (serverId: string) => void;
}

export function UninstallServerDialog({
  server,
  onClose,
  isCancelingInstallation = false,
  onCancelInstallation,
}: UninstallServerDialogProps) {
  const uninstallMutation = useDeleteMcpServer();

  const handleConfirm = async () => {
    if (!server) return;

    // If canceling installation, notify parent to stop polling
    if (isCancelingInstallation && onCancelInstallation) {
      onCancelInstallation(server.id);
    }

    await uninstallMutation.mutateAsync({
      id: server.id,
      name: server.name,
    });
    onClose();
  };

  const title = isCancelingInstallation
    ? "Cancel Installation"
    : "Uninstall MCP Server";
  const description = isCancelingInstallation
    ? `Are you sure you want to cancel the installation of "${server?.name || ""}"?`
    : `Are you sure you want to uninstall "${server?.name || ""}"?`;
  const confirmButtonText = isCancelingInstallation
    ? "Cancel Installation"
    : "Uninstall";
  const confirmingButtonText = isCancelingInstallation
    ? "Canceling..."
    : "Uninstalling...";

  return (
    <DeleteConfirmDialog
      open={!!server}
      onOpenChange={() => onClose()}
      title={title}
      description={description}
      isPending={uninstallMutation.isPending}
      onConfirm={handleConfirm}
      confirmLabel={confirmButtonText}
      pendingLabel={confirmingButtonText}
    />
  );
}
