"use client";

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
import { useDeleteApp } from "@/lib/app.query";

// Deleting tears down the app's backing catalog/server; the query invalidation
// in useDeleteApp refreshes both the gallery and the MCP registry card.
export function AppDeleteDialog({
  app,
  open,
  onOpenChange,
  onDeleted,
}: {
  app: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful delete (in addition to closing the dialog). */
  onDeleted?: () => void;
}) {
  const deleteApp = useDeleteApp();

  const handleConfirm = async () => {
    const data = await deleteApp.mutateAsync(app.id);
    if (data) {
      onOpenChange(false);
      onDeleted?.();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader className="border-b-0">
          <DialogTitle>Delete app</DialogTitle>
        </DialogHeader>
        <DialogForm
          className="flex min-h-0 flex-1 flex-col"
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) {
              return;
            }
            e.preventDefault();
            handleConfirm();
          }}
          onSubmit={(e) => {
            e.preventDefault();
            handleConfirm();
          }}
        >
          <div className="flex flex-col gap-3 px-4 pb-4">
            <DialogDescription>
              Are you sure you want to delete &quot;{app.name}&quot;? This
              permanently removes the app and its version history and cannot be
              undone.
            </DialogDescription>
          </div>
          <DialogStickyFooter className="mt-0 border-t-0 shadow-none">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={deleteApp.isPending}
            >
              {deleteApp.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
