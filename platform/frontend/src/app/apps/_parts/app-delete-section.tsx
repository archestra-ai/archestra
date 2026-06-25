"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { useDeleteApp } from "@/lib/app.query";

type App = archestraApiTypes.GetAppResponses["200"];

export function AppDeleteSection({ app }: { app: App }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Delete app</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Permanently delete this app and its version history. This cannot be
          undone.
        </p>
      </div>
      <PermissionButton
        permissions={{ app: ["delete"] }}
        noPermissionHandle="hide"
        variant="destructive"
        size="sm"
        className="mt-2 self-start"
        onClick={() => setOpen(true)}
      >
        Delete app
      </PermissionButton>
      <DeleteAppDialog app={app} open={open} onOpenChange={setOpen} />
    </section>
  );
}

function DeleteAppDialog({
  app,
  open,
  onOpenChange,
}: {
  app: App;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const deleteApp = useDeleteApp();
  const [confirmName, setConfirmName] = useState("");

  const canDelete = confirmName === app.name && !deleteApp.isPending;

  const handleConfirm = () => {
    if (!canDelete) return;
    deleteApp.mutate(app.id, {
      onSuccess: (data) => {
        if (!data) return;
        onOpenChange(false);
        router.push("/apps");
      },
    });
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setConfirmName("");
        onOpenChange(next);
      }}
      title={`Delete "${app.name}"?`}
      description="This permanently deletes the app and its version history and cannot be undone."
      size="small"
    >
      <DialogForm
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          handleConfirm();
        }}
      >
        <DialogBody className="space-y-2">
          <Label htmlFor="confirm-app-name" className="block">
            Type <span className="font-bold text-foreground">{app.name}</span>{" "}
            to confirm
          </Label>
          <Input
            id="confirm-app-name"
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            autoComplete="off"
          />
        </DialogBody>
        <DialogStickyFooter className="mt-0 border-t-0 shadow-none">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" variant="destructive" disabled={!canDelete}>
            {deleteApp.isPending ? "Deleting..." : "Delete"}
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}
