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
  onConfirm: () => unknown;
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
  /**
   * Keeps the confirm button disabled for this long after the dialog opens,
   * so a notice about what else goes with the removal gets read first.
   */
  confirmDelayMs?: number;
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
  confirmDelayMs,
}: DeleteConfirmDialogProps) {
  const inputId = useId();
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);
  const [coolingDown, setCoolingDown] = useState(false);
  useEffect(() => {
    if (!open || !confirmDelayMs) {
      setCoolingDown(false);
      return;
    }
    setCoolingDown(true);
    const timer = setTimeout(() => setCoolingDown(false), confirmDelayMs);
    return () => clearTimeout(timer);
  }, [open, confirmDelayMs]);
  const blocked =
    isPending ||
    confirmDisabled ||
    coolingDown ||
    (confirmationPhrase !== undefined && typed.trim() !== confirmationPhrase);

  const confirm = () => {
    if (!blocked) onConfirm();
  };

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
          // A held Enter repeats; only the press itself confirms.
          if (e.repeat) {
            e.preventDefault();
            return;
          }
          e.preventDefault();
          confirm();
        }}
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
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
          <Button
            type="submit"
            variant={confirmVariant}
            disabled={blocked}
            // `isPending` reaches this button one render after the click
            // that started the request, and the second click of a double
            // click lands inside that gap: the removal was sent twice, and
            // the repeat came back "not found" for one that had just worked.
            // The browser counts the clicks of a double click, so the second
            // is refused by its count, with no timer to guess the gap.
            onClick={(event) => {
              if (event.detail > 1) event.preventDefault();
            }}
          >
            {isPending ? pendingLabel : confirmLabel}
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}
