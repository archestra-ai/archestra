"use client";

import { useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDeleteApp } from "@/lib/app.query";

// Confirm-by-name delete: the caller must retype the app name to arm the
// destructive button. Deleting tears down the app's backing catalog/server, so
// the query invalidation in useDeleteApp refreshes both the gallery and the
// MCP registry card.
export function AppDeleteDialog({
  app,
  open,
  onOpenChange,
}: {
  app: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteApp = useDeleteApp();
  const [confirmName, setConfirmName] = useState("");
  const canDelete = confirmName === app.name && !deleteApp.isPending;

  const close = (next: boolean) => {
    if (!next) setConfirmName("");
    onOpenChange(next);
  };

  const handleConfirm = async () => {
    if (!canDelete) return;
    const data = await deleteApp.mutateAsync(app.id);
    if (data) close(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
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
              Permanently delete this app and its version history. This cannot
              be undone.
            </DialogDescription>
            <div className="space-y-2">
              <Label htmlFor="confirm-app-name" className="block">
                Type{" "}
                <span className="font-bold text-foreground">{app.name}</span> to
                confirm
              </Label>
              <Input
                id="confirm-app-name"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                autoComplete="off"
              />
            </div>
          </div>
          <DialogStickyFooter className="mt-0 border-t-0 shadow-none">
            <Button
              type="button"
              variant="outline"
              onClick={() => close(false)}
            >
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!canDelete}>
              {deleteApp.isPending ? "Deleting…" : "Delete app"}
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
