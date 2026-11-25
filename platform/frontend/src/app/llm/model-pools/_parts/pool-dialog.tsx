"use client";

import { MODEL_POOL_RETRY_DEFAULTS } from "@archestra/shared/model-pool-retries";
import { Info, Layers, Loader2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import {
  type TabbedDialogNavItem,
  TabbedDialogShell,
} from "@/components/tabbed-dialog-shell";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
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
import {
  ModelNameField,
  RoutingStrategyField,
  TimeoutFields,
} from "./pool-fields";
import {
  type PoolFormValues,
  toFormValues,
  toPoolInput,
  usePoolOptions,
  usePoolProblem,
} from "./pool-form";
import { MemberRetryOverrides, RetryFields } from "./retry-fields";

export type PoolDialogSection = "pool" | "failover" | "connect";

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
  const [activeSection, setActiveSection] = useState<PoolDialogSection>(
    !pool && initialSection === "connect" ? "pool" : initialSection,
  );
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
  const members = form.watch("members");
  const retries =
    form.watch("retrySettings")?.numRetries ??
    MODEL_POOL_RETRY_DEFAULTS.numRetries;

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
      <RoutingStrategyField form={form} disabled={disabled} />
      <MembersEditor
        form={form}
        options={options}
        disabled={disabled}
        savedMembers={live?.members ?? []}
      />
      {members.some(
        (member) => options.keysById.get(member.providerApiKeyId)?.userId,
      ) ? (
        <InlineNotice variant="info">
          <Info />
          <span className="font-medium">Personal connections stay private</span>
          <InlineNoticeText>
            Only requests authenticated as their owner use these members. Other
            callers use the pool's shared connections.
          </InlineNoticeText>
        </InlineNotice>
      ) : null}
    </>
  );
  const failoverFields = (
    <>
      <TimeoutFields form={form} disabled={disabled} />
      <RetryFields form={form} disabled={disabled} />
      <MemberRetryOverrides
        form={form}
        options={options}
        disabled={disabled}
        savedMembers={live?.members ?? []}
      />
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

  const title = pool?.name ?? "New model pool";
  const description = pool
    ? "Edit the pool's members, what happens when one fails, or see how clients call it."
    : "Serve one model name from several provider keys, with failover between them.";
  const memberCount = live?.members.length ?? members.length;
  const navItems: TabbedDialogNavItem<PoolDialogSection>[] = [
    {
      id: "pool",
      label: "Pool",
      status: `${memberCount} ${memberCount === 1 ? "member" : "members"}`,
    },
    {
      id: "failover",
      label: "Failover",
      status: `${retries} ${retries === 1 ? "retry" : "retries"}`,
    },
  ];
  if (pool)
    navItems.push({ id: "connect", label: "Connect", status: "Code samples" });

  return (
    <TabbedDialogShell
      open
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      headerDescription={!pool ? description : undefined}
      sidebarLabel={title}
      sidebarDescription="Model pool"
      sidebarIcon={<Layers className="h-4 w-4 text-muted-foreground" />}
      isDirty={isDirty}
      activeSection={activeSection}
      navItems={navItems}
      onActiveSectionChange={setActiveSection}
      onSubmit={(event) => void onSubmit(event)}
      footer={
        activeSection === "connect" && !isDirty ? (
          <DialogCancelButton>Close</DialogCancelButton>
        ) : (
          <>
            {!pool && options.availableKeys.length === 0 && (
              <p className="mr-auto text-xs text-muted-foreground">
                Add a provider connection first.
              </p>
            )}
            <DialogCancelButton>Cancel</DialogCancelButton>
            {saveButton}
          </>
        )
      }
    >
      <div hidden={activeSection !== "pool"} className="space-y-6">
        {fields}
      </div>
      <div hidden={activeSection !== "failover"} className="space-y-6">
        {failoverFields}
      </div>
      {activeSection === "connect" && live && (
        <PoolConnectSection pool={live} />
      )}
    </TabbedDialogShell>
  );
}
