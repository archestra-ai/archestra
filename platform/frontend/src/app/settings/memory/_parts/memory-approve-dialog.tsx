"use client";

import { type archestraApiTypes, E2eTestId } from "@shared";
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
import { useApproveMemory, useUpdateMemoryCandidate } from "@/lib/memory.query";
import {
  getMemoryKindLabel,
  type MemoryKind,
  type MemoryListItem,
} from "./memory-utils";

type ApproveDialogFormValues = {
  content: string;
  kind: MemoryKind;
};

const MEMORY_KIND_OPTIONS: ReadonlyArray<MemoryKind> = [
  "preference",
  "profile_fact",
  "instruction",
  "team_convention",
  "org_fact",
];

export function MemoryApproveDialog({
  item,
  open,
  onOpenChange,
  disabled,
}: {
  item: MemoryListItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
}) {
  const approveMemory = useApproveMemory();
  const updateMemory = useUpdateMemoryCandidate();

  const form = useForm<ApproveDialogFormValues>({
    defaultValues: {
      content: "",
      kind: "preference",
    },
  });

  useEffect(() => {
    if (!item) return;
    form.reset({
      content: item.content,
      kind: item.kind,
    });
  }, [item, form]);

  const handleSubmit = form.handleSubmit(async (values) => {
    if (!item || disabled) return;

    const updateBody: archestraApiTypes.UpdateMemoryData["body"] = {};
    if (values.content !== item.content) {
      updateBody.content = values.content;
    }
    if (values.kind !== item.kind) {
      updateBody.kind = values.kind;
    }

    if (Object.keys(updateBody).length > 0) {
      const updated = await updateMemory.mutateAsync({
        id: item.id,
        body: updateBody,
      });
      if (!updated) {
        return;
      }
    }

    const approved = await approveMemory.mutateAsync(item.id);
    if (!approved) {
      return;
    }

    onOpenChange(false);
  });

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Approve memory"
      description="Review and optionally edit candidate content before approval."
      size="medium"
    >
      <DialogForm onSubmit={handleSubmit}>
        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="memory-approve-kind">Kind</Label>
            <Select
              value={form.watch("kind")}
              onValueChange={(value: MemoryKind) =>
                form.setValue("kind", value)
              }
              disabled={
                approveMemory.isPending || updateMemory.isPending || disabled
              }
            >
              <SelectTrigger id="memory-approve-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEMORY_KIND_OPTIONS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {getMemoryKindLabel(kind)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="memory-approve-content">Content</Label>
            <Textarea
              id="memory-approve-content"
              value={form.watch("content")}
              onChange={(event) => form.setValue("content", event.target.value)}
              disabled={
                approveMemory.isPending || updateMemory.isPending || disabled
              }
              rows={6}
              maxLength={500}
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
            disabled={
              approveMemory.isPending || updateMemory.isPending || disabled
            }
            data-testid={E2eTestId.MemoryApproveButton}
          >
            Approve
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}
