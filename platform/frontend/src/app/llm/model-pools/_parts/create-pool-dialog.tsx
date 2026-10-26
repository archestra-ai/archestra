"use client";

import { Loader2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { AdvancedSection } from "@/components/advanced-section";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useCreateModelPool } from "@/lib/model-pools.query";
import { AccessField, MembersEditor, ModelNameField } from "./pool-fields";
import {
  type PoolFormValues,
  toFormValues,
  toPoolInput,
  usePoolOptions,
  usePoolProblem,
} from "./pool-form";

/**
 * Creates a pool: its name, its members, and (under Advanced) the virtual keys
 * that may use it. Mount it only while open, so each opening starts blank.
 */
export function CreatePoolDialog({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}) {
  const form = useForm<PoolFormValues>({ defaultValues: toFormValues(null) });
  const options = usePoolOptions();
  const problem = usePoolProblem(form, null);
  const createPool = useCreateModelPool();

  const onSubmit = form.handleSubmit(async (values) => {
    const created = await createPool.mutateAsync(toPoolInput(values));
    if (created) onOpenChange(false);
  });

  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title="New model pool"
      description="Serve one model from several provider keys, with failover between them."
      size="small"
      className="sm:max-w-[720px]"
      isDirty={form.formState.isDirty}
    >
      <form onSubmit={onSubmit} className="flex min-h-0 flex-col">
        <DialogBody className="space-y-6">
          <ModelNameField
            form={form}
            options={options}
            disabled={false}
            taken={problem === "taken"}
          />
          <div className="space-y-2">
            <Label>Members</Label>
            <MembersEditor
              form={form}
              options={options}
              disabled={false}
              savedMembers={[]}
            />
          </div>
          <AdvancedSection keepMounted>
            <AccessField form={form} options={options} disabled={false} />
          </AdvancedSection>
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          {options.sharedKeys.length === 0 ? (
            <p className="mr-auto text-xs text-muted-foreground">
              <span>Add a shared provider key first.</span>
            </p>
          ) : null}
          <DialogCancelButton>Cancel</DialogCancelButton>
          <Button
            type="submit"
            disabled={problem !== null || createPool.isPending}
          >
            {createPool.isPending && <Loader2 className="animate-spin" />}
            <span>Create pool</span>
          </Button>
        </DialogStickyFooter>
      </form>
    </FormDialog>
  );
}
