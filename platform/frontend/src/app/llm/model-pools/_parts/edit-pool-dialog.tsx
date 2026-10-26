"use client";

import { Layers, Loader2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useConnectionBaseUrl } from "@/components/virtual-key-connection-base-url";
import { CodeExample } from "@/components/virtual-key-connection-guide";
import {
  buildCurlExample,
  getProxyBaseUrl,
} from "@/components/virtual-key-request-example";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type ModelPool,
  useModelPools,
  useUpdateModelPool,
} from "@/lib/model-pools.query";
import { useBenchedMembers } from "./member-status";
import {
  AccessField,
  FailureRules,
  MembersEditor,
  ModelNameField,
} from "./pool-fields";
import {
  accessSummary,
  orderSummary,
  type PoolFormValues,
  toFormValues,
  toPoolInput,
  usePoolOptions,
  usePoolProblem,
} from "./pool-form";

type Section = "general" | "members" | "connect";

/**
 * Edits one pool in tabs, as a virtual key is edited. The form is seeded once,
 * when the dialog opens: the list refetches every few seconds for member
 * status, and those refetches must not wipe edits in progress. Status is read
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
  const [section, setSection] = useState<Section>("general");

  const { data: pools = [] } = useModelPools({ toastOnError: false });
  const live = pools.find((row) => row.id === pool.id) ?? pool;
  const benched = useBenchedMembers(live);

  const name = form.watch("name").trim();
  const members = form.watch("members");
  const virtualApiKeyIds = form.watch("virtualApiKeyIds");
  const isDirty = form.formState.isDirty;

  const onSubmit = form.handleSubmit(async (values) => {
    const saved = await updatePool.mutateAsync({
      id: pool.id,
      body: toPoolInput(values),
    });
    if (saved) onOpenChange(false);
  });

  const memberStatus = `${orderSummary(members)}${
    benched.length > 0 ? `, ${benched.length} benched` : ""
  }`;

  return (
    <TabbedDialogShell
      open
      onOpenChange={onOpenChange}
      title={pool.name}
      description="Edit the pool's name, who can use it, and its members."
      sidebarLabel={name || "Model pool"}
      sidebarDescription="Model pool"
      sidebarIcon={<Layers className="h-4 w-4 text-muted-foreground" />}
      isDirty={isDirty}
      activeSection={section}
      onActiveSectionChange={setSection}
      navItems={[
        {
          id: "general",
          label: "General",
          status: accessSummary(virtualApiKeyIds.length),
        },
        { id: "members", label: "Members", status: memberStatus },
        { id: "connect", label: "Connect", status: "Code sample" },
      ]}
      onSubmit={(event) => void onSubmit(event)}
      footer={
        section === "connect" && !isDirty ? (
          <DialogCancelButton>Close</DialogCancelButton>
        ) : (
          <>
            <DialogCancelButton>Cancel</DialogCancelButton>
            <Button
              type="submit"
              disabled={
                disabled || !isDirty || problem !== null || updatePool.isPending
              }
            >
              {updatePool.isPending && <Loader2 className="animate-spin" />}
              <span>Save Changes</span>
            </Button>
          </>
        )
      }
    >
      <div hidden={section !== "general"} className="space-y-6">
        <ModelNameField
          form={form}
          options={options}
          disabled={disabled}
          taken={problem === "taken"}
        />
        <AccessField form={form} options={options} disabled={disabled} />
      </div>
      <div hidden={section !== "members"} className="space-y-4">
        <MembersEditor
          form={form}
          options={options}
          disabled={disabled}
          savedMembers={live.members}
        />
        <FailureRules />
      </div>
      {section === "connect" ? <ConnectExample poolName={pool.name} /> : null}
    </TabbedDialogShell>
  );
}

/** A Model Router request for the pool's name, with a virtual key that may use it. */
function ConnectExample({ poolName }: { poolName: string }) {
  const connectionBaseUrl = useConnectionBaseUrl();
  const example = buildCurlExample({
    connectionBaseUrl,
    target: { kind: "model-router" },
    keyType: "standard",
    keyValue: "$ARCHESTRA_LLM_VIRTUAL_KEY",
    model: poolName,
  });
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Base URL</Label>
        <code className="block rounded-md border bg-muted px-3 py-2 font-mono text-sm break-all">
          {getProxyBaseUrl(connectionBaseUrl, { kind: "model-router" })}
        </code>
        <p className="text-xs text-muted-foreground">
          Any OpenAI-compatible client works: point it at this URL and ask for
          the model <span className="font-mono">{poolName}</span>. Clients on a
          provider route, such as Claude Code on the Anthropic route, can ask
          for the same name. Claude Code doesn't know a non-Claude name and
          assumes a 200k context window: set{" "}
          <span className="font-mono">CLAUDE_CODE_MAX_CONTEXT_TOKENS</span> to
          the smallest window among the pool's members.
        </p>
      </div>
      {example ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Set <span className="font-mono">ARCHESTRA_LLM_VIRTUAL_KEY</span> to
            a virtual key that maps one of the members or is listed under Who
            can use it, then run:
          </p>
          <CodeExample language="curl" code={example} />
        </div>
      ) : null}
    </div>
  );
}
