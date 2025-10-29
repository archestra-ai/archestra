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
}

export function ReinstallConfirmationDialog({
  isOpen,
  onClose,
  onConfirm,
  serverName,
  isReinstalling,
}: ReinstallConfirmationDialogProps) {
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Reinstall Required</DialogTitle>
          <DialogDescription className="py-4">
            The configuration for <strong>{serverName}</strong> has been
            updated. The server needs to be reinstalled for the changes to take
            effect.
            <span className="text-sm text-muted-foreground block mt-2">
              Reinstalling will uninstall the current server instance and
              install it again with the updated configuration.
            </span>
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
                Reinstalling...
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                Reinstall Now
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
