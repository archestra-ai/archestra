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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md overflow-hidden">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogForm
          onSubmit={(e) => {
            e.preventDefault();
            onConfirm();
          }}
        >
          <DialogStickyFooter>
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
      </DialogContent>
    </Dialog>
  );
}
