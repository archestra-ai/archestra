"use client";

import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";

type SensitiveDataConfirmDialogProps = {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function SensitiveDataConfirmDialog({
  open,
  onConfirm,
  onCancel,
}: SensitiveDataConfirmDialogProps) {
  return (
    <StandardDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onCancel();
        }
      }}
      title="Possible sensitive data detected"
      size="small"
      footer={
        <>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            Send anyway
          </Button>
        </>
      }
    >
      Your message seems to contain sensitive data, are you sure?
    </StandardDialog>
  );
}
