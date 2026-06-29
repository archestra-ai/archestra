"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogForm,
  DialogHeader,
  DialogStickyFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDeleteMcpServer } from "@/lib/mcp/mcp-server.query";

export interface UninstallServerInstall {
  server: { id: string; name: string };
}

interface UninstallServerDialogProps {
  open: boolean;
  onClose: () => void;
  installs: UninstallServerInstall[];
  isCancelingInstallation?: boolean;
  onCancelInstallation?: (serverId: string) => void;
}

export function UninstallServerDialog({
  open,
  onClose,
  installs,
  isCancelingInstallation = false,
  onCancelInstallation,
}: UninstallServerDialogProps) {
  const uninstallMutation = useDeleteMcpServer();

  const server = installs[0]?.server ?? null;

  const handleConfirm = async () => {
    if (!server) return;

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
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader className="border-b-0">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogForm
          className="flex min-h-0 flex-1 flex-col"
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) {
              return;
            }
            e.preventDefault();
            handleConfirm();
          }}
          onSubmit={(e) => {
            e.preventDefault();
            handleConfirm();
          }}
        >
          <div className="flex flex-col gap-3 px-4 pb-4">
            <DialogDescription>{description}</DialogDescription>
          </div>
          <DialogStickyFooter className="mt-0 border-t-0 shadow-none">
            <Button type="button" variant="outline" onClick={() => onClose()}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={uninstallMutation.isPending}
            >
              {uninstallMutation.isPending
                ? confirmingButtonText
                : confirmButtonText}
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
