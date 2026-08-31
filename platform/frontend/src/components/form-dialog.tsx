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
  /** Block Esc from closing — the X button stays the only dismissal. */
  preventCloseOnEscape?: boolean;
  /**
   * When the form holds unsaved data, closing it (Esc, outside-click, or the
   * X button) shows a "Discard unsaved changes?" confirmation instead of
   * silently dropping the edits. Leave undefined/false to keep the form
   * unguarded.
   */
  isDirty?: boolean;
  className?: string;
  /** Extra classes for the header block, e.g. `border-b-0` to drop its rule. */
  headerClassName?: string;
  /** Receives focus when the dialog opens instead of the first body control. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
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
  preventCloseOnEscape,
  isDirty = false,
  className,
  headerClassName,
  initialFocusRef,
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
          onEscapeKeyDown={
            preventCloseOnEscape ? (e) => e.preventDefault() : undefined
          }
          onOpenAutoFocus={
            initialFocusRef
              ? (event) => {
                  event.preventDefault();
                  initialFocusRef.current?.focus();
                }
              : undefined
          }
        >
          <DialogDismissProvider requestClose={guard.requestClose}>
            <DialogHeader className={headerClassName}>
              {/* The DialogTitle/DialogDescription elements persist across
                  wizard steps, so a title that switches between a string and
                  an element would delete a bare text node in place — which
                  crashes React once Chrome page-translate has re-parented it
                  into a <font> wrapper (facebook/react#11538). Keying the
                  wrapper span by the string content swaps a whole element on
                  every string<->element or string<->string change instead. */}
              <DialogTitle>
                <span key={typeof title === "string" ? title : "node"}>
                  {title}
                </span>
              </DialogTitle>
              {description && (
                <DialogDescription>
                  <span
                    key={typeof description === "string" ? description : "node"}
                  >
                    {description}
                  </span>
                </DialogDescription>
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
