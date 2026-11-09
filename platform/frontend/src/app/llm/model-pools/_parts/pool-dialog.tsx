"use client";

import { Layers, Loader2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { FormDialog } from "@/components/form-dialog";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
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
import { MembersEditor } from "./members-editor";
import { PoolConnectSection } from "./pool-connect-section";
import { ModelNameField, TimeoutFields } from "./pool-fields";
import {
  type PoolFormValues,
  toFormValues,
  toPoolInput,
  usePoolOptions,
  usePoolProblem,
} from "./pool-form";
import { RetryFields } from "./retry-fields";

export type PoolDialogSection = "pool" | "connect";

/**
 * Creates a pool, or edits `pool`, with a Connect section beside its settings
 * as virtual keys have. Mount it only while open: the form is seeded once, so
 * each opening starts fresh, and the list's refetches every few seconds for
 * cooldowns don't wipe edits in progress. Cooldowns are read from the live
 * list instead.
 */
export function PoolDialog({
  pool,
  initialSection = "pool",
  onOpenChange,
  onCreated,
}: {
  pool: ModelPool | null;
  initialSection?: PoolDialogSection;
  onOpenChange: (open: boolean) => void;
  /** Called with a new pool once it is saved. */
  onCreated?: (pool: ModelPool) => void;
}) {
  const [activeSection, setActiveSection] =
    useState<PoolDialogSection>(initialSection);
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
      // A new pool has no member cooling down yet.
      if (created)
        onCreated?.({
          ...created,
          members: created.members.map((member) => ({
            ...member,
            benchedUntil: null,
            benchReason: null,
          })),
        });
      return;
    }
    const saved = await updatePool.mutateAsync({
      id: pool.id,
      body: toPoolInput(values),
    });
    if (saved) onOpenChange(false);
  });

  const fields = (
    <>
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
      <RetryFields form={form} disabled={disabled} />
    </>
  );
  const saveButton = (
    <Button
      type="submit"
      disabled={
        disabled || (pool !== null && !isDirty) || problem !== null || pending
      }
    >
      {pending && <Loader2 className="animate-spin" />}
      <span>{pool ? "Save changes" : "Create pool"}</span>
    </Button>
  );

  if (pool) {
    const memberCount = live?.members.length ?? 0;
    return (
      <TabbedDialogShell
        open
        onOpenChange={onOpenChange}
        title={pool.name}
        description="Edit the pool's members and timeouts, or see how clients call it."
        sidebarLabel={pool.name}
        sidebarDescription="Model pool"
        sidebarIcon={<Layers className="h-4 w-4 text-muted-foreground" />}
        isDirty={isDirty}
        activeSection={activeSection}
        navItems={[
          {
            id: "pool",
            label: "Pool",
            status: `${memberCount} ${memberCount === 1 ? "member" : "members"}`,
          },
          { id: "connect", label: "Connect", status: "Code samples" },
        ]}
        onActiveSectionChange={setActiveSection}
        onSubmit={(event) => void onSubmit(event)}
        footer={
          activeSection === "connect" && !isDirty ? (
            <DialogCancelButton>Close</DialogCancelButton>
          ) : (
            <>
              <DialogCancelButton>Cancel</DialogCancelButton>
              {saveButton}
            </>
          )
        }
      >
        <div hidden={activeSection !== "pool"} className="space-y-6">
          {fields}
        </div>
        {activeSection === "connect" && (
          <PoolConnectSection pool={live ?? pool} />
        )}
      </TabbedDialogShell>
    );
  }

  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title="New model pool"
      description="Serve one model name from several provider keys, with failover between them."
      size="small"
      className="sm:max-w-[860px]"
      isDirty={isDirty}
    >
      <form onSubmit={onSubmit} className="flex min-h-0 flex-col">
        <DialogBody className="space-y-6">{fields}</DialogBody>
        <DialogStickyFooter className="mt-0">
          {options.sharedKeys.length === 0 ? (
            <p className="mr-auto text-xs text-muted-foreground">
              <span>Add a shared provider key first.</span>
            </p>
          ) : null}
          <DialogCancelButton>Cancel</DialogCancelButton>
          {saveButton}
        </DialogStickyFooter>
      </form>
    </FormDialog>
  );
}
