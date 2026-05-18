"use client";

import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
  presetLabel: string | null;
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
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Reinstall Required</DialogTitle>
          <DialogDescription>
            The configuration for <strong>{serverName}</strong> has been
            updated. The server needs to be reinstalled for the changes to take
            effect.
          </DialogDescription>
        </DialogHeader>

        {targets.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">
              The following {targets.length === 1 ? "install" : "installs"} will
              be reinstalled:
            </p>
            <ul className="space-y-1.5">
              {targets.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                >
                  {t.presetLabel && (
                    <Badge
                      variant="secondary"
                      className="text-[10px] font-medium"
                    >
                      {t.presetLabel}
                    </Badge>
                  )}
                  <span className="font-mono text-xs truncate">{t.name}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

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
