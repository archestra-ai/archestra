"use client";

import type * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FormDialogViewContext } from "@/components/form-dialog-view";

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogStickyFooter,
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
  onClick?: React.MouseEventHandler<HTMLDivElement>;
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
  onClick,
}: FormDialogProps) {
  const [view, setView] = useState<{
    title: string;
    description: string;
  } | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const setDialogView = useCallback(
    (next: { title: string; description: string } | null) => {
      if (next && document.activeElement instanceof HTMLElement)
        returnFocus.current = document.activeElement;
      setView(next);
    },
    [],
  );
  useEffect(() => {
    if (!view) returnFocus.current?.focus();
  }, [view]);
  const [viewDirty, setViewDirty] = useState(false);
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) {
      setView(null);
      setViewDirty(false);
    }
  }, [open]);
  const guard = useUnsavedChangesGuard({
    isDirty: isDirty || viewDirty,
    onOpenChange,
  });
  const displayedTitle = view?.title ?? title;
  const displayedDescription = view?.description ?? description;

  return (
    <>
      <Dialog open={open} onOpenChange={guard.handleOpenChange}>
        <DialogContent
          className={cn(sizeClasses[size], className)}
          onClick={onClick}
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
                <span
                  key={
                    typeof displayedTitle === "string" ? displayedTitle : "node"
                  }
                >
                  {displayedTitle}
                </span>
              </DialogTitle>
              {displayedDescription && (
                <DialogDescription>
                  <span
                    key={
                      typeof displayedDescription === "string"
                        ? displayedDescription
                        : "node"
                    }
                  >
                    {displayedDescription}
                  </span>
                </DialogDescription>
              )}
            </DialogHeader>
            <FormDialogViewContext.Provider
              value={{
                setView: setDialogView,
                setDirty: setViewDirty,
                body,
                footer,
              }}
            >
              <div hidden={!!view} className={view ? undefined : "contents"}>
                {children}
              </div>
              {view && (
                <>
                  <DialogBody>
                    <div ref={setBody} />
                  </DialogBody>
                  <DialogStickyFooter className="mt-0">
                    <div
                      ref={setFooter}
                      className="flex w-full justify-end gap-2"
                    />
                  </DialogStickyFooter>
                </>
              )}
            </FormDialogViewContext.Provider>
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
