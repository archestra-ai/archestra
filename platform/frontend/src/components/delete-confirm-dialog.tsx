import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
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
          onConfirm();
        }}
        onSubmit={(e) => {
          e.preventDefault();
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
          <Button type="submit" variant="destructive" disabled={isPending}>
            {isPending ? pendingLabel : confirmLabel}
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}
