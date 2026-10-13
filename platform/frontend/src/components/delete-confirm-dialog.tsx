import { useEffect, useId, useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import { Button, type ButtonProps } from "@/components/ui/button";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type DeleteConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string | React.ReactNode;
  isPending: boolean;
  onConfirm: () => void;
  confirmLabel?: string;
  pendingLabel?: string;
  confirmDisabled?: boolean;
  /**
   * Defaults to the destructive red this dialog is named for. Reusable by
   * confirmations that are merely irreversible-looking rather than destructive,
   * where red would overstate what the action does.
   */
  confirmVariant?: ButtonProps["variant"];
  /**
   * Text the user must type before confirming, for removals that are hard to
   * undo outside the app — so a stray click cannot delete the wrong thing.
   */
  confirmationPhrase?: string;
};

export function DeleteConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  isPending,
  onConfirm,
  confirmLabel = "Delete",
  pendingLabel = "Deleting...",
  confirmDisabled = false,
  confirmVariant = "destructive",
  confirmationPhrase,
}: DeleteConfirmDialogProps) {
  const inputId = useId();
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);
  const blocked =
    isPending ||
    confirmDisabled ||
    (confirmationPhrase !== undefined && typed.trim() !== confirmationPhrase);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="small"
    >
      <DialogForm
        className="flex min-h-0 flex-1 flex-col"
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) {
            return;
          }
          e.preventDefault();
          if (blocked) {
            return;
          }
          onConfirm();
        }}
        onSubmit={(e) => {
          e.preventDefault();
          if (blocked) {
            return;
          }
          onConfirm();
        }}
      >
        {confirmationPhrase !== undefined && (
          <DialogBody className="flex flex-col gap-2">
            <Label htmlFor={inputId}>
              <span>
                Type <span className="font-mono">{confirmationPhrase}</span> to
                confirm
              </span>
            </Label>
            <Input
              id={inputId}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </DialogBody>
        )}
        <DialogStickyFooter className="mt-0 border-t-0 shadow-none">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" variant={confirmVariant} disabled={blocked}>
            {isPending ? pendingLabel : confirmLabel}
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}
