import { FormDialog } from "@/components/form-dialog";
import { Button, type ButtonProps } from "@/components/ui/button";
import { DialogForm, DialogStickyFooter } from "@/components/ui/dialog";

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
}: DeleteConfirmDialogProps) {
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
          if (isPending || confirmDisabled) {
            return;
          }
          onConfirm();
        }}
        onSubmit={(e) => {
          e.preventDefault();
          if (isPending || confirmDisabled) {
            return;
          }
          onConfirm();
        }}
      >
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
            disabled={isPending || confirmDisabled}
          >
            {isPending ? pendingLabel : confirmLabel}
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}
