"use client";

import { AlertCircle } from "lucide-react";
import { useCallback, useState } from "react";

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

import { resolveCloseAttempt } from "./unsaved-changes-guard-utils";

/**
 * Guards a dialog against discarding unsaved form data. Funnels every close
 * path (Esc, outside-click, the X button, and any explicit Cancel/close
 * handler that calls `requestClose`) through a dirty check, showing a
 * confirmation before the form is discarded.
 *
 * Wire it up by passing `handleOpenChange` to the dialog's `onOpenChange`,
 * calling `requestClose()` from custom close buttons, and rendering
 * `<UnsavedChangesDialog>` with the returned confirm state.
 */
export function useUnsavedChangesGuard({
  isDirty,
  onOpenChange,
}: {
  isDirty: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      switch (resolveCloseAttempt({ nextOpen, isDirty })) {
        case "open":
          onOpenChange(true);
          break;
        case "confirm":
          setConfirmOpen(true);
          break;
        case "close":
          onOpenChange(false);
          break;
      }
    },
    [isDirty, onOpenChange],
  );

  const requestClose = useCallback(
    () => handleOpenChange(false),
    [handleOpenChange],
  );

  const keepEditing = useCallback(() => setConfirmOpen(false), []);

  const discardChanges = useCallback(() => {
    setConfirmOpen(false);
    onOpenChange(false);
  }, [onOpenChange]);

  return {
    handleOpenChange,
    requestClose,
    confirmOpen,
    keepEditing,
    discardChanges,
  };
}

export function UnsavedChangesDialog({
  open,
  onKeepEditing,
  onDiscard,
}: {
  open: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        // Dismissing the confirmation itself (Esc/outside-click) is the safe
        // choice: keep the form open, do not discard.
        if (!nextOpen) {
          onKeepEditing();
        }
      }}
    >
      <DialogContent className="max-w-md flex flex-col overflow-hidden">
        <DialogHeader className="border-b-0">
          <DialogTitle className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-amber-500" />
            Discard unsaved changes?
          </DialogTitle>
          <DialogDescription>
            You have unsaved changes. If you close now, they will be lost.
          </DialogDescription>
        </DialogHeader>
        <DialogForm
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => e.preventDefault()}
        >
          <DialogStickyFooter className="mt-0">
            <Button type="button" variant="outline" onClick={onKeepEditing}>
              Keep editing
            </Button>
            <Button
              type="button"
              variant="outline"
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={onDiscard}
            >
              Discard changes
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
