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
  useCreateModelPool,
  useModelPools,
  useUpdateModelPool,
} from "@/lib/model-pools.query";
import type { ConnectablePool } from "./connect-pool-dialog";
import { MembersEditor } from "./members-editor";
import { ModelNameField, TimeoutFields } from "./pool-fields";
import {
  type PoolFormValues,
  toFormValues,
  toPoolInput,
  usePoolOptions,
  usePoolProblem,
} from "./pool-form";

/**
 * Creates a pool, or edits `pool`. Mount it only while open: the form is
 * seeded once, so each opening starts fresh, and the list's refetches every
 * few seconds for cooldowns don't wipe edits in progress. Cooldowns are read
 * from the live list instead.
 */
export function PoolDialog({
  pool,
  onOpenChange,
  onCreated,
}: {
  pool: ModelPool | null;
  onOpenChange: (open: boolean) => void;
  /** Called with a new pool, to show how to connect to it. */
  onCreated?: (pool: ConnectablePool) => void;
}) {
  const { data: canEdit } = useHasPermissions({ llmModel: ["update"] });
  const disabled = pool !== null && !canEdit;
  const form = useForm<PoolFormValues>({ defaultValues: toFormValues(pool) });
  const options = usePoolOptions();
  const problem = usePoolProblem(form, pool?.id ?? null);
  const createPool = useCreateModelPool();
  const updatePool = useUpdateModelPool();
  const pending = createPool.isPending || updatePool.isPending;

  const { data: pools = [] } = useModelPools({ toastOnError: false });
  const live = pools.find((row) => row.id === pool?.id) ?? pool;
  const isDirty = form.formState.isDirty;

  const onSubmit = form.handleSubmit(async (values) => {
    if (!pool) {
      const created = await createPool.mutateAsync(toPoolInput(values));
      if (created) onCreated?.(created);
      return;
    }
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
      title={pool?.name ?? "New model pool"}
      description={
        pool
          ? undefined
          : "Serve one model name from several provider keys, with failover between them."
      }
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
            savedMembers={live?.members ?? []}
          />
          <TimeoutFields form={form} disabled={disabled} />
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          {!pool && options.sharedKeys.length === 0 ? (
            <p className="mr-auto text-xs text-muted-foreground">
              <span>Add a shared provider key first.</span>
            </p>
          ) : null}
          <DialogCancelButton>Cancel</DialogCancelButton>
          <Button
            type="submit"
            disabled={
              disabled ||
              (pool !== null && !isDirty) ||
              problem !== null ||
              pending
            }
          >
            {pending && <Loader2 className="animate-spin" />}
            <span>{pool ? "Save changes" : "Create pool"}</span>
          </Button>
        </DialogStickyFooter>
      </form>
    </FormDialog>
  );
}
