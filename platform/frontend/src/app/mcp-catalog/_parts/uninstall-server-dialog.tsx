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
}

export function UninstallServerDialog({
  server,
  onClose,
}: UninstallServerDialogProps) {
  const uninstallMutation = useDeleteMcpServer();

  const handleConfirm = async () => {
    if (!server) return;
    await uninstallMutation.mutateAsync({
      id: server.id,
      name: server.name,
    });
    onClose();
  };

  return (
    <Dialog open={!!server} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Uninstall MCP Server</DialogTitle>
          <DialogDescription>
            Are you sure you want to uninstall "{server?.name || ""}"?
          </DialogDescription>
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
            {uninstallMutation.isPending ? "Uninstalling..." : "Uninstall"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
