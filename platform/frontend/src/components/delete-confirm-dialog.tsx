import { useEffect, useId, useRef, useState } from "react";
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

  // `isPending` reaches the button one render after the click that started
  // the request, and the second click of a double click lands inside that
  // gap: the removal was sent twice, and the repeat came back "not found" for
  // one that had just worked. The ref closes the gap, being set in the same
  // tick as the first confirm.
  const confirmingRef = useRef(false);
  const isPendingRef = useRef(isPending);
  isPendingRef.current = isPending;
  // biome-ignore lint/correctness/useExhaustiveDependencies: released when the request settles or the dialog opens or closes
  useEffect(() => {
    if (!isPending) confirmingRef.current = false;
  }, [isPending, open]);
  const confirm = () => {
    if (blocked || confirmingRef.current) return;
    confirmingRef.current = true;
    const result = onConfirm();
    if (result instanceof Promise) {
      void result.then(
        () => {
          confirmingRef.current = false;
        },
        () => {
          confirmingRef.current = false;
        },
      );
      return;
    }
    // A confirm that starts no request (it refused, and left the dialog open)
    // never turns `isPending`, so nothing above would release the button.
    // Later than any double click, it is released unless a request is running.
    setTimeout(() => {
      if (!isPendingRef.current) confirmingRef.current = false;
    }, DOUBLE_CLICK_WINDOW_MS);
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
          <Button type="submit" variant={confirmVariant} disabled={blocked}>
            {isPending ? pendingLabel : confirmLabel}
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

/** Longer than the gap between the two clicks of a double click. */
const DOUBLE_CLICK_WINDOW_MS = 600;
