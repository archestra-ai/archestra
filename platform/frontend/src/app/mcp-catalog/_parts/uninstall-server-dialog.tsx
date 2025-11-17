"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
    <Dialog open={!!server} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={uninstallMutation.isPending}
          >
            {uninstallMutation.isPending
              ? confirmingButtonText
              : confirmButtonText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
