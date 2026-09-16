"use client";

import { Check, FileCode2, Loader2, LockKeyhole, Save } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { Editor } from "@/components/editor";
import { QueryLoadError } from "@/components/query-load-error";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type GuardrailsPolicy,
  useGuardrailsPolicy,
  useUpdateGuardrailsPolicy,
  useValidateGuardrailsPolicy,
} from "@/lib/guardrails-policy.query";
import { useAppaGithubSync } from "@/lib/openappa-github-sync.query";

export function GuardrailsPolicyEditor() {
  const policy = useGuardrailsPolicy();
  const sync = useAppaGithubSync();
  if (policy.isLoading || sync.isPending)
    return <Skeleton className="h-[65vh] w-full" />;
  if (policy.isError || !policy.data || sync.isError)
    return (
      <QueryLoadError
        title="Could not load policy"
        onRetry={() => {
          policy.refetch();
          sync.refetch();
        }}
      />
    );
  return (
    <PolicyForm policy={policy.data} synced={!!sync.data?.source?.interval} />
  );
}

function PolicyForm({
  policy,
  synced,
}: {
  policy: GuardrailsPolicy;
  synced: boolean;
}) {
  const { data: hasEditPermission } = useHasPermissions({
    toolPolicy: ["update"],
  });
  const canEdit = hasEditPermission && !synced;
  const form = useForm({
    defaultValues: {
      content: policy.content,
      expectedRevision: policy.revision,
    },
  });
  const content = form.watch("content");
  const revision = form.watch("expectedRevision");
  const dirty = form.formState.isDirty;
  const save = useUpdateGuardrailsPolicy();
  const validation = useValidateGuardrailsPolicy();
  const busy = save.isPending || validation.isPending;
  const changedElsewhere = policy.revision !== revision;
  const checked =
    validation.variables === content ? validation.data : undefined;

  useEffect(() => {
    if (!dirty && policy.revision !== form.getValues("expectedRevision"))
      form.reset({
        content: policy.content,
        expectedRevision: policy.revision,
      });
  }, [dirty, policy, form]);
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);

  const submit = form.handleSubmit((values) =>
    save.mutate(values, {
      onSuccess: (saved) => {
        if (saved)
          form.reset({
            content: saved.content,
            expectedRevision: saved.revision,
          });
        validation.reset();
      },
    }),
  );

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border bg-background">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex items-center gap-3">
            <FileCode2 className="size-4 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-medium">Policy editor</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                organization.appa.toml
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <output className="text-xs text-muted-foreground">
              {dirty
                ? "Unsaved changes"
                : revision === 0
                  ? "Not yet saved"
                  : `Revision ${revision}`}
            </output>
            {!canEdit && (
              <Badge variant="secondary">
                <LockKeyhole className="mr-1 size-3" />
                <span>{synced ? "Synced from GitHub" : "Read only"}</span>
              </Badge>
            )}
            {canEdit && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || !content.trim()}
                  onClick={() => validation.mutate(content)}
                >
                  {validation.isPending && (
                    <Loader2 className="size-3.5 animate-spin" />
                  )}
                  <span>Validate</span>
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={busy || !content.trim() || (!dirty && revision > 0)}
                >
                  {save.isPending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Save className="size-3.5" />
                  )}
                  <span>Save &amp; apply</span>
                </Button>
              </>
            )}
          </div>
        </div>
        <Editor
          height="min(50vh, 560px)"
          language="ini"
          value={content}
          onChange={(value) => {
            form.setValue("content", value ?? "", { shouldDirty: true });
            save.reset();
          }}
          options={{
            readOnly: !canEdit || save.isPending,
            ariaLabel: "Organization guardrails policy",
            minimap: { enabled: false },
            fontSize: 14,
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            wordWrap: "on",
            padding: { top: 16, bottom: 16 },
            automaticLayout: true,
          }}
        />
        <div className="border-t px-4 py-3 text-xs text-muted-foreground">
          Saved changes apply to new conversations. Existing conversations keep
          their original policy.
        </div>
      </div>
      {changedElsewhere && dirty && (
        <Alert>
          <AlertDescription>
            A newer revision is available. Your edits are preserved. Copy your
            changes before reloading this page to reconcile them.
          </AlertDescription>
        </Alert>
      )}
      {checked && (
        <Alert variant={checked.valid ? "default" : "destructive"}>
          {checked.valid && <Check className="size-4" />}
          <AlertDescription
            className="whitespace-pre-wrap font-mono text-xs"
            role="status"
          >
            {checked.valid ? "Policy is valid." : checked.errors.join("\n")}
          </AlertDescription>
        </Alert>
      )}
      {save.isError && (
        <Alert variant="destructive">
          <AlertDescription className="whitespace-pre-wrap" role="alert">
            {save.error.message}
          </AlertDescription>
        </Alert>
      )}
    </form>
  );
}
