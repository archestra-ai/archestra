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

interface CascadeReinstallConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  isPending: boolean;
  serverCount: number;
  presetCount: number;
}

export function CascadeReinstallConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  isPending,
  serverCount,
  presetCount,
}: CascadeReinstallConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reinstall affected servers?</DialogTitle>
          <DialogDescription className="space-y-2 pt-2">
            <span className="block">
              Saving will reinstall <strong>{serverCount}</strong>{" "}
              {serverCount === 1 ? "server" : "servers"}
              {presetCount > 0 ? (
                <>
                  {" "}
                  across <strong>{presetCount + 1}</strong>{" "}
                  {presetCount + 1 === 1 ? "preset" : "presets"}
                </>
              ) : null}
              .
            </span>
            <span className="block text-xs">
              Servers that need new user input will be marked for manual
              reinstall instead.
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm} disabled={isPending}>
            {isPending ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              "Save and reinstall"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
