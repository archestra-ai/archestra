"use client";

import { RefreshCw } from "lucide-react";
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

interface ReinstallTarget {
  id: string;
  name: string;
}

interface ReinstallConfirmationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  serverName: string;
  isReinstalling: boolean;
  targets?: ReinstallTarget[];
}

export function ReinstallConfirmationDialog({
  isOpen,
  onClose,
  onConfirm,
  serverName,
  isReinstalling,
  targets = [],
}: ReinstallConfirmationDialogProps) {
  const installationCount = targets.length;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Reinstall Required</DialogTitle>
          <DialogDescription>
            The configuration for <strong>{serverName}</strong> has been
            updated.{" "}
            {installationCount > 0 ? (
              <>
                <strong>{installationCount}</strong>{" "}
                {installationCount === 1 ? "installation" : "installations"}{" "}
                will be reinstalled for the changes to take effect.
              </>
            ) : (
              <>
                The server needs to be reinstalled for the changes to take
                effect.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogForm onSubmit={onConfirm}>
          <DialogStickyFooter className="border-t-0 shadow-none">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isReinstalling}
            >
              Skip for Now
            </Button>
            <Button type="submit" disabled={isReinstalling}>
              {isReinstalling ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  Reinstalling...
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4" />
                  Reinstall Now
                </>
              )}
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
