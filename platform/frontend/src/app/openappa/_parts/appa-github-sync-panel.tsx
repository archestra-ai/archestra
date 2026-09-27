"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Github,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { QueryLoadError } from "@/components/query-load-error";
import { RuntimeCredentialConnectionDialog } from "@/components/runtime-credential-connection-dialog";
import { RuntimeCredentialDefinitionDialog } from "@/components/settings/runtime-credential-definition-dialog";
import {
  SettingsBlock,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
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
import { copyToClipboard } from "@/lib/clipboard";
import { useGuardrailsPolicy } from "@/lib/guardrails-policy.query";
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
    <SettingsSectionStack>
      <SettingsBlock
        title={
          <span className="inline-flex items-center gap-2">
            GitHub sync
            <Badge
              variant={source?.lastSyncError ? "destructive" : "secondary"}
            >
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
          </span>
        }
        description={
          connected
            ? "Keep the OpenAPPA policy in a repository and pull validated updates on a schedule."
            : "Keep the OpenAPPA policy in GitHub. Connect a self-contained APPA TOML file; failed pulls keep the last valid policy in place."
        }
        control={
          enabled && !source?.repo && canManage ? (
            <Button size="sm" onClick={() => setEditing(true)}>
              <Github className="size-4" />
              <span>Connect GitHub</span>
            </Button>
          ) : undefined
        }
      >
        {(!enabled || source?.repo) && (
          <div className="space-y-4">
            {!enabled ? (
              <p className="text-sm text-muted-foreground">
                Ask your administrator to enable APPA on the server to connect a
                policy repository.
              </p>
            ) : // A row can exist for its declaration flags alone, with no source on it.
            source?.repo && source.path ? (
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
                    <span className="text-muted-foreground">
                      {" "}
                      / {source.path}
                    </span>
                  </a>
                  <Badge variant="outline">
                    {source.ref ?? "Default branch"}
                  </Badge>
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
            ) : null}
          </div>
        )}
      </SettingsBlock>
      {editing && (
        <OpenAppaSourceForm source={source} onOpenChange={setEditing} />
      )}
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
    </SettingsSectionStack>
  );
}

export function OpenAppaSourceForm({
  source,
  onOpenChange,
}: {
  source: Source | null;
  onOpenChange: (open: boolean) => void;
}) {
  const mutation = useConfigureAppaGithubSync();
  const policy = useGuardrailsPolicy();
  const [credentialStep, setCredentialStep] = useState<
    "source" | "define" | "connect"
  >("source");
  const [newCredentialId, setNewCredentialId] = useState<string | null>(null);
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
  const newCredential = available.find(
    (credential) => credential.id === newCredentialId,
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
    <>
      <StandardFormDialog
        open={credentialStep === "source"}
        onOpenChange={onOpenChange}
        isDirty={form.formState.isDirty}
        title={source ? "Edit GitHub source" : "Connect OpenAPPA to GitHub"}
        description="Pull the policy file from GitHub. The first valid pull replaces the policy saved here, so commit your current policy to the repository first."
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
        {!source?.repo && (
          <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
            <p className="font-medium">Before you connect</p>
            <ol className="list-decimal space-y-2 pl-5 text-muted-foreground">
              <li>
                Commit your current policy to the repository as{" "}
                <span className="font-mono text-foreground">appa.toml</span>.{" "}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="ml-1 h-7"
                  disabled={!policy.data}
                  onClick={async () => {
                    if (!policy.data) return;
                    await copyToClipboard(policy.data.content);
                    toast.success("Policy copied");
                  }}
                >
                  <Copy />
                  <span>Copy current policy</span>
                </Button>
              </li>
              <li>
                Add the policy tests to CI, so a pull request that breaks the
                policy can&apos;t merge.{" "}
                <ExternalDocsLink href="https://www.openappa.com/validation#make-policy-tests-a-required-ci-check">
                  Test changes in CI
                </ExternalDocsLink>
              </li>
            </ol>
          </div>
        )}
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
            <Label htmlFor="appa-ref">Branch</Label>
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
            onValueChange={(value) =>
              form.setValue("credential", value, { shouldDirty: true })
            }
          >
            <SelectTrigger id="appa-credential" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {apps.map((app) => (
                <SelectItem key={app.id} value={`app:${app.id}`}>
                  {app.name} (GitHub App)
                </SelectItem>
              ))}
              {pats.map((pat) => (
                <SelectItem key={pat.id} value={`pat:${pat.id}`}>
                  {pat.name} (saved token)
                </SelectItem>
              ))}
              <SelectItem value="public">
                Public repository (no credential)
              </SelectItem>
            </SelectContent>
          </Select>
          {!form.watch("credential").startsWith("app:") && (
            <InlineNotice variant="info" className="flex-nowrap gap-3">
              <Github className="shrink-0" />
              <div className="min-w-0 flex-1">
                <span className="font-medium">
                  Use a GitHub App for policy PRs
                </span>
                <InlineNoticeText>
                  Agents need an App credential to propose policy changes.
                </InlineNoticeText>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                type="button"
                onClick={() => setCredentialStep("define")}
              >
                Set up credential
              </Button>
            </InlineNotice>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="appa-frequency">Sync frequency</Label>
          <Select
            value={form.watch("interval")}
            onValueChange={(value) =>
              form.setValue("interval", value as "15m" | "1h" | "1d", {
                shouldDirty: true,
              })
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
          Use one TOML file, up to 1 MiB. OpenAPPA validates every update before
          accepting it.
        </p>
      </StandardFormDialog>
      {credentialStep === "define" && (
        <RuntimeCredentialDefinitionDialog
          definition={null}
          initialKind="github_app"
          initialScope="organization"
          backLabel="Back to GitHub sync"
          size="medium"
          onClose={() => setCredentialStep("source")}
          onCreated={(id) => {
            setNewCredentialId(id);
            form.setValue("credential", `app:${id}`, { shouldDirty: true });
            setCredentialStep("connect");
          }}
        />
      )}
      {credentialStep === "connect" && newCredential && (
        <RuntimeCredentialConnectionDialog
          definition={newCredential}
          scope="organization"
          onClose={() => setCredentialStep("source")}
        />
      )}
    </>
  );
}
