"use client";

import type * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DialogDismissProvider,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { cn } from "@/lib/utils";

type DialogSize = "small" | "medium" | "large";

export type FormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string | React.ReactNode;
  description?: string | React.ReactNode;
  size?: DialogSize;
  children: React.ReactNode;
  preventCloseOnInteractOutside?: boolean;
  /**
   * When the form holds unsaved data, closing it (Esc, outside-click, or the
   * X button) shows a "Discard unsaved changes?" confirmation instead of
   * silently dropping the edits. Leave undefined/false to keep the form
   * unguarded.
   */
  isDirty?: boolean;
  className?: string;
};

// Flex column + overflow-hidden come from the base DialogContent.
const sizeClasses: Record<DialogSize, string> = {
  small: "max-w-md max-h-[85vh]",
  medium: "max-w-2xl max-h-[85vh]",
  large: "max-w-5xl h-[90vh]",
};

export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  size = "medium",
  children,
  preventCloseOnInteractOutside,
  isDirty = false,
  className,
}: FormDialogProps) {
  const guard = useUnsavedChangesGuard({ isDirty, onOpenChange });

  return (
    <>
      <Dialog open={open} onOpenChange={guard.handleOpenChange}>
        <DialogContent
          className={cn(sizeClasses[size], className)}
          onInteractOutside={
            preventCloseOnInteractOutside
              ? (e) => e.preventDefault()
              : undefined
          }
        >
          <DialogDismissProvider requestClose={guard.requestClose}>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              {description && (
                <DialogDescription>{description}</DialogDescription>
              )}
            </DialogHeader>
            {children}
          </DialogDismissProvider>
        </DialogContent>
      </Dialog>
      <UnsavedChangesDialog
        open={guard.confirmOpen}
        onKeepEditing={guard.keepEditing}
        onDiscard={guard.discardChanges}
      />
    </>
  );
}
