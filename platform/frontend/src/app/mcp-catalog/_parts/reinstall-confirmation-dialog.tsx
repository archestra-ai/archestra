"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ReinstallConfirmationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  serverName: string;
  isReinstalling: boolean;
  isRemoteServer: boolean;
}

export function ReinstallConfirmationDialog({
  isOpen,
  onClose,
  onConfirm,
  serverName,
  isReinstalling,
  isRemoteServer,
}: ReinstallConfirmationDialogProps) {
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isRemoteServer ? "Reconnect" : "Reinstall"} Required
          </DialogTitle>
          <DialogDescription className="py-4">
            The configuration for <strong>{serverName}</strong> has been
            updated. The server needs to be reinstalled for the changes to take
            effect.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isReinstalling}>
            Skip for Now
          </Button>
          <Button onClick={onConfirm} disabled={isReinstalling}>
            {isReinstalling ? (
              <>
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                {isRemoteServer ? "Reconnecting..." : "Reinstalling..."}
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                {isRemoteServer ? "Reconnect Now" : "Reinstall Now"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
