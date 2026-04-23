"use client";

import { E2eTestId } from "@shared";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useRejectMemory } from "@/lib/memory.query";
import {
  MEMORY_REJECTION_REASON_OPTIONS,
  type MemoryListItem,
  type MemoryRejectionReason,
} from "./memory-utils";

type RejectDialogFormValues = {
  rejectionReason: MemoryRejectionReason | "";
  rejectionComment: string;
};

export function MemoryRejectDialog({
  item,
  open,
  onOpenChange,
}: {
  item: MemoryListItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rejectMemory = useRejectMemory();
  const form = useForm<RejectDialogFormValues>({
    defaultValues: {
      rejectionReason: "",
      rejectionComment: "",
    },
  });

  useEffect(() => {
    if (!open) {
      form.reset({
        rejectionReason: "",
        rejectionComment: "",
      });
    }
  }, [open, form]);

  const handleSubmit = form.handleSubmit(async (values) => {
    if (!item || !values.rejectionReason) return;
    const rejected = await rejectMemory.mutateAsync({
      id: item.id,
      body: {
        rejectionReason: values.rejectionReason,
        rejectionComment: values.rejectionComment.trim() || undefined,
      },
    });

    if (!rejected) {
      return;
    }

    onOpenChange(false);
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Reject memory"
      description="Rejection reason is required to keep review decisions auditable."
      size="medium"
    >
      <DialogForm onSubmit={handleSubmit}>
        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="memory-reject-reason">Reason</Label>
            <Select
              value={form.watch("rejectionReason")}
              onValueChange={(value: MemoryRejectionReason) =>
                form.setValue("rejectionReason", value, {
                  shouldValidate: true,
                })
              }
              disabled={rejectMemory.isPending}
            >
              <SelectTrigger id="memory-reject-reason">
                <SelectValue placeholder="Select rejection reason" />
              </SelectTrigger>
              <SelectContent>
                {MEMORY_REJECTION_REASON_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="memory-reject-comment">Comment (optional)</Label>
            <Textarea
              id="memory-reject-comment"
              value={form.watch("rejectionComment")}
              onChange={(event) =>
                form.setValue("rejectionComment", event.target.value)
              }
              disabled={rejectMemory.isPending}
              rows={4}
            />
          </div>
        </DialogBody>
        <DialogStickyFooter>
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
            disabled={!form.watch("rejectionReason") || rejectMemory.isPending}
            data-testid={E2eTestId.MemoryRejectButton}
          >
            Reject
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}
