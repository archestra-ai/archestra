"use client";

import { Loader2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type ModelPool,
  useModelPools,
  useUpdateModelPool,
} from "@/lib/model-pools.query";
import { FailoverNote, MembersEditor, ModelNameField } from "./pool-fields";
import {
  type PoolFormValues,
  toFormValues,
  toPoolInput,
  usePoolOptions,
  usePoolProblem,
} from "./pool-form";

/**
 * Edits one pool in the same form that creates it. The form is seeded once,
 * when the dialog opens: the list refetches every few seconds for cooldowns,
 * and those refetches must not wipe edits in progress. Cooldowns are read
 * from the live list instead.
 */
export function EditPoolDialog({
  pool,
  onOpenChange,
}: {
  pool: ModelPool;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: canEdit } = useHasPermissions({ llmModel: ["update"] });
  const disabled = !canEdit;
  const form = useForm<PoolFormValues>({ defaultValues: toFormValues(pool) });
  const options = usePoolOptions();
  const problem = usePoolProblem(form, pool.id);
  const updatePool = useUpdateModelPool();

  const { data: pools = [] } = useModelPools({ toastOnError: false });
  const live = pools.find((row) => row.id === pool.id) ?? pool;
  const isDirty = form.formState.isDirty;

  const onSubmit = form.handleSubmit(async (values) => {
    const saved = await updatePool.mutateAsync({
      id: pool.id,
      body: toPoolInput(values),
    });
    if (saved) onOpenChange(false);
  });

  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title={pool.name}
      size="small"
      className="sm:max-w-[860px]"
      isDirty={isDirty}
    >
      <form onSubmit={onSubmit} className="flex min-h-0 flex-col">
        <DialogBody className="space-y-6">
          <ModelNameField
            form={form}
            options={options}
            disabled={disabled}
            taken={problem === "taken"}
          />
          <MembersEditor
            form={form}
            options={options}
            disabled={disabled}
            savedMembers={live.members}
          />
          <FailoverNote />
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          <DialogCancelButton>Cancel</DialogCancelButton>
          <Button
            type="submit"
            disabled={
              disabled || !isDirty || problem !== null || updatePool.isPending
            }
          >
            {updatePool.isPending && <Loader2 className="animate-spin" />}
            <span>Save changes</span>
          </Button>
        </DialogStickyFooter>
      </form>
    </FormDialog>
  );
}
