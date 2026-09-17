"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  AlertTriangle,
  CheckCircle2,
  Github,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { QueryLoadError } from "@/components/query-load-error";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useAppaGithubSync,
  useConfigureAppaGithubSync,
  useUpdateAppaGithubSync,
} from "@/lib/openappa-github-sync.query";
import { useRuntimeCredentials } from "@/lib/runtime-credentials.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

type Source = NonNullable<
  archestraApiTypes.GetAppaGithubSyncResponses["200"]["source"]
>;
const intervals = {
  "15m": "Every 15 minutes",
  "1h": "Every hour",
  "1d": "Once a day",
};

export function AppaGithubSyncPanel() {
  const query = useAppaGithubSync();
  const update = useUpdateAppaGithubSync();
  const { data: canManage } = useHasPermissions({ organization: ["update"] });
  const [editing, setEditing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  if (query.isPending) return <Skeleton className="mb-6 h-32 w-full" />;
  if (query.isError || !query.data)
    return (
      <QueryLoadError
        title="Could not load APPA sync"
        onRetry={() => query.refetch()}
        className="mb-6 h-auto"
      />
    );
  const { source, enabled, hasPolicy } = query.data;
  const connected = !!source?.interval;
  return (
    <section
      aria-label="APPA GitHub sync"
      className="overflow-hidden rounded-lg border bg-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="rounded-md border bg-muted/50 p-2">
            <ShieldCheck className="size-5 text-primary" />
          </div>
          <div>
            <h2 className="font-semibold">GitHub sync</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Keep your guardrails in GitHub. Pull validated updates on a
              schedule.
            </p>
          </div>
        </div>
        <Badge variant={source?.lastSyncError ? "destructive" : "secondary"}>
          {!enabled
            ? "Disabled"
            : source?.lastSyncError
              ? "Sync failed"
              : connected
                ? "GitHub connected"
                : hasPolicy
                  ? "Sync stopped"
                  : "Managed locally"}
        </Badge>
      </div>
      <div className="space-y-4 px-5 py-4">
        {!enabled ? (
          <p className="text-sm text-muted-foreground">
            Ask your administrator to enable APPA on the server to connect a
            policy repository.
          </p>
        ) : source ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Github className="size-4 shrink-0 text-muted-foreground" />
              <a
                className="font-mono text-sm underline underline-offset-4"
                href={`https://github.com/${source.repo}/blob/${encodeURIComponent(source.ref ?? "HEAD")}/${source.path.split("/").map(encodeURIComponent).join("/")}`}
                target="_blank"
                rel="noreferrer"
              >
                {source.repo}
                <span className="text-muted-foreground"> / {source.path}</span>
              </a>
              <Badge variant="outline">{source.ref ?? "Default branch"}</Badge>
              {connected && (
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <Select
                    value={source.interval ?? "1h"}
                    disabled={!canManage || update.isPending}
                    onValueChange={(interval) =>
                      update.mutate({
                        action: "schedule",
                        interval: interval as "15m" | "1h" | "1d",
                      })
                    }
                  >
                    <SelectTrigger
                      aria-label="APPA sync frequency"
                      className="w-44"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(intervals).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {canManage && (
                    <Button
                      variant="outline"
                      disabled={update.isPending}
                      onClick={() => update.mutate({ action: "sync" })}
                    >
                      <RefreshCw className="size-4" />
                      <span>Sync now</span>
                    </Button>
                  )}
                </div>
              )}
            </div>
            <div
              className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground"
              aria-live="polite"
            >
              {source.lastSyncError ? (
                <p
                  role="alert"
                  className="flex items-start gap-2 text-destructive"
                >
                  <AlertTriangle className="size-4 shrink-0" />
                  <span>{source.lastSyncError}</span>
                </p>
              ) : (
                <p className="flex items-center gap-1.5">
                  <CheckCircle2 className="size-3.5" />
                  <span>
                    {source.lastSyncedAt
                      ? `Last checked ${formatRelativeTimeFromNow(source.lastSyncedAt).toLowerCase()}`
                      : connected
                        ? "Waiting for the first sync"
                        : "Automatic updates stopped"}
                  </span>
                </p>
              )}
              {source.sourceCommit && (
                <a
                  className="font-mono underline underline-offset-4"
                  href={`https://github.com/${source.repo}/commit/${source.sourceCommit}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {source.sourceCommit.slice(0, 7)}
                </a>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
              <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
                {hasPolicy
                  ? connected
                    ? "New trajectories use the last accepted policy. Existing trajectories keep their pinned policy."
                    : "Automatic updates are stopped. You can edit the current policy above."
                  : "The current policy stays active until a valid GitHub policy is accepted."}
              </p>
              {canManage && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing(true)}
                  >
                    {connected ? "Edit source" : "Reconnect GitHub"}
                  </Button>
                  {connected && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDisconnecting(true)}
                    >
                      Stop syncing
                    </Button>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-2xl text-sm text-muted-foreground">
              Connect a self-contained APPA TOML file. Failed pulls keep the
              last valid policy in place.
            </p>
            {canManage && (
              <Button onClick={() => setEditing(true)}>
                <Github className="size-4" />
                <span>Connect GitHub</span>
              </Button>
            )}
          </div>
        )}
      </div>
      {editing && <SourceForm source={source} onOpenChange={setEditing} />}
      <DeleteConfirmDialog
        open={disconnecting}
        onOpenChange={setDisconnecting}
        title="Stop APPA policy sync?"
        description="The last accepted policy stays active. Automatic GitHub updates stop until you reconnect."
        confirmLabel="Stop syncing"
        pendingLabel="Stopping…"
        isPending={update.isPending}
        onConfirm={async () => {
          await update.mutateAsync({ action: "disconnect" });
          setDisconnecting(false);
        }}
      />
    </section>
  );
}

function SourceForm({
  source,
  onOpenChange,
}: {
  source: Source | null;
  onOpenChange: (open: boolean) => void;
}) {
  const mutation = useConfigureAppaGithubSync();
  const { data: canReadCredentials } = useHasPermissions({
    credential: ["read"],
  });
  const credentials = useRuntimeCredentials(!!canReadCredentials);
  const available =
    credentials.data?.filter((credential) => credential.allowOrganization) ??
    [];
  const pats = available.filter((credential) => credential.kind === "secret");
  const apps = available.filter(
    (credential) => credential.kind === "github_app",
  );
  const form = useForm({
    defaultValues: {
      repo: source?.repo ?? "",
      ref: source?.ref ?? "",
      path: source?.path ?? "appa.toml",
      interval: source?.interval ?? "1h",
      credential: source?.githubPatId
        ? `pat:${source.githubPatId}`
        : source?.githubAppConfigId
          ? `app:${source.githubAppConfigId}`
          : "public",
    },
  });
  const submit = form.handleSubmit((values) =>
    mutation.mutate(
      {
        repo: values.repo.trim(),
        ref: values.ref.trim() || null,
        path: values.path.trim(),
        interval: values.interval,
        githubPatId: values.credential.startsWith("pat:")
          ? values.credential.slice(4)
          : null,
        githubAppConfigId: values.credential.startsWith("app:")
          ? values.credential.slice(4)
          : null,
      },
      { onSuccess: () => onOpenChange(false) },
    ),
  );
  return (
    <StandardFormDialog
      open
      onOpenChange={onOpenChange}
      title={source ? "Edit GitHub source" : "Connect APPA to GitHub"}
      description="Pull a policy file from GitHub. Your current policy stays active until a valid update is accepted."
      size="medium"
      className="w-[calc(100%-2rem)] sm:max-w-xl"
      bodyClassName="space-y-5"
      onSubmit={submit}
      footer={
        <>
          <DialogCancelButton disabled={mutation.isPending} />
          <Button type="submit" disabled={mutation.isPending}>
            <span>
              {mutation.isPending ? "Saving…" : "Save source and sync"}
            </span>
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Label htmlFor="appa-repo">Repository</Label>
        <Input
          id="appa-repo"
          placeholder="owner/repository"
          {...form.register("repo", {
            required: true,
            pattern: /^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/,
          })}
          aria-invalid={!!form.formState.errors.repo}
        />
        {form.formState.errors.repo && (
          <p role="alert" className="text-sm text-destructive">
            Enter a repository as owner/repository.
          </p>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="appa-ref">Branch or tag</Label>
          <Input
            id="appa-ref"
            placeholder="Default branch"
            {...form.register("ref")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="appa-path">Policy file</Label>
          <Input
            id="appa-path"
            {...form.register("path", { required: true })}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="appa-credential">Authentication</Label>
        <Select
          value={form.watch("credential")}
          onValueChange={(value) => form.setValue("credential", value)}
        >
          <SelectTrigger id="appa-credential" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="public">
              Public repository (no credential)
            </SelectItem>
            {pats.map((pat) => (
              <SelectItem key={pat.id} value={`pat:${pat.id}`}>
                {pat.name} (saved token)
              </SelectItem>
            ))}
            {apps.map((app) => (
              <SelectItem key={app.id} value={`app:${app.id}`}>
                {app.name} (GitHub App)
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="appa-frequency">Sync frequency</Label>
        <Select
          value={form.watch("interval")}
          onValueChange={(value) =>
            form.setValue("interval", value as "15m" | "1h" | "1d")
          }
        >
          <SelectTrigger id="appa-frequency" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(intervals).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="rounded-md border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
        Use one self-contained TOML file, up to 1 MiB. Includes and local
        command bindings are unsupported. APPA validates every update before
        accepting it.
      </p>
    </StandardFormDialog>
  );
}
