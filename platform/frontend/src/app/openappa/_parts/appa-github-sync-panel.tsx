"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Github,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { OpenAppaGithubAppRequirements } from "@/components/openappa-github-app-requirements";
import { QueryLoadError } from "@/components/query-load-error";
import { RuntimeCredentialConnectionDialog } from "@/components/runtime-credential-connection-dialog";
import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";
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
import { OPENAPPA_GITHUB_CREDENTIAL_INITIAL_VALUES } from "@/lib/openappa-github-credential";
import {
  useAppaGithubSync,
  useConfigureAppaGithubSync,
  useCreateAppaGithubRepository,
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
  const [creating, setCreating] = useState(false);
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
    <SettingsSectionStack className="max-w-4xl">
      <SettingsBlock
        title={
          <span className="inline-flex items-center gap-2">
            GitHub sync
            <Badge variant={source?.lastSyncError ? "destructive" : "outline"}>
              {!enabled
                ? "Disabled"
                : source?.lastSyncError
                  ? "Sync failed"
                  : connected
                    ? "Connected"
                    : hasPolicy
                      ? "Sync stopped"
                      : "Managed locally"}
            </Badge>
          </span>
        }
        description={
          connected
            ? "Policy changes are reviewed in GitHub. Merged updates sync automatically."
            : "Store your policy in GitHub and review changes in pull requests."
        }
        control={
          enabled && !source?.repo && canManage ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Github className="size-4" />
              <span>Create GitHub repository</span>
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
              <div className="overflow-hidden rounded-lg border bg-card">
                <div className="flex flex-wrap items-center gap-4 p-4">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
                      <Github className="size-5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                      <a
                        className="inline-flex max-w-full items-center gap-2 text-sm font-medium hover:underline underline-offset-4"
                        href={`https://github.com/${source.repo}/blob/${encodeURIComponent(source.ref ?? "HEAD")}/${source.path.split("/").map(encodeURIComponent).join("/")}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <span className="truncate">{source.repo}</span>
                        <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
                      </a>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <GitBranch className="size-3.5" />
                          {source.ref ?? "Default branch"}
                        </span>
                        <span className="font-mono">{source.path}</span>
                      </div>
                      <div
                        className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground"
                        aria-live="polite"
                      >
                        {source.lastSyncError ? (
                          <InlineNotice variant="error">
                            <AlertTriangle className="size-4 shrink-0" />
                            <span className="font-medium">Sync failed</span>
                            <InlineNoticeText>
                              {source.lastSyncError}
                            </InlineNoticeText>
                          </InlineNotice>
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
                    </div>
                  </div>
                  {connected && (
                    <div className="ml-auto flex items-center gap-2">
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
                          id="appa-sync-frequency"
                          aria-label="APPA sync frequency"
                          size="sm"
                          className="w-36 py-1 text-xs data-[size=sm]:h-7"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper">
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
                          size="sm"
                          className="h-7 px-2 text-xs"
                          disabled={update.isPending}
                          onClick={() => update.mutate({ action: "sync" })}
                        >
                          <RefreshCw className="size-3.5" />
                          <span>Sync now</span>
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t bg-muted/30 px-4 py-2">
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {hasPolicy
                      ? connected
                        ? "Updates apply to new conversations. Active conversations keep their current policy."
                        : "Automatic updates are stopped. Your last synced policy stays active."
                      : "The current policy stays active until a valid GitHub policy is accepted."}
                  </p>
                  {canManage && (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => setEditing(true)}
                      >
                        {connected ? "Edit source" : "Reconnect GitHub"}
                      </Button>
                      {connected && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => setDisconnecting(true)}
                        >
                          Stop syncing
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </SettingsBlock>
      {editing && (
        <OpenAppaSourceForm source={source} onOpenChange={setEditing} />
      )}
      {creating && (
        <OpenAppaCreateRepositoryDialog
          onOpenChange={setCreating}
          onConnectExisting={() => {
            setCreating(false);
            setEditing(true);
          }}
        />
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

export function OpenAppaCreateRepositoryDialog({
  onOpenChange,
  onConnectExisting,
}: {
  onOpenChange: (open: boolean) => void;
  onConnectExisting: () => void;
}) {
  const mutation = useCreateAppaGithubRepository();
  const [credentialStep, setCredentialStep] = useState<
    "repository" | "define" | "connect"
  >("repository");
  const [newCredentialId, setNewCredentialId] = useState<string | null>(null);
  const { data: canReadCredentials } = useHasPermissions({
    credential: ["read"],
  });
  const credentials = useRuntimeCredentials(!!canReadCredentials);
  const apps =
    credentials.data?.filter(
      (credential) =>
        credential.allowOrganization &&
        credential.organizationConfigured &&
        credential.kind === "github_app",
    ) ?? [];
  const newCredential = credentials.data?.find(
    (credential) => credential.id === newCredentialId,
  );
  const form = useForm({
    defaultValues: {
      repo: "",
      githubAppConfigId: "",
      interval: "1h" as "15m" | "1h" | "1d",
    },
  });
  return (
    <>
      <StandardFormDialog
        open={credentialStep === "repository"}
        onOpenChange={onOpenChange}
        isDirty={form.formState.isDirty}
        title="Create OpenAPPA repository"
        description="Copy the OpenAPPA template into a private GitHub repository. Your current policy, including battery declarations, becomes its first policy."
        size="medium"
        onSubmit={form.handleSubmit((values) => {
          const [owner, name] = values.repo.trim().split("/");
          mutation.mutate(
            {
              owner,
              name,
              githubAppConfigId: values.githubAppConfigId,
              interval: values.interval,
            },
            { onSuccess: () => onOpenChange(false) },
          );
        })}
        footer={
          <>
            <Button type="button" variant="ghost" onClick={onConnectExisting}>
              <span>Connect existing repository</span>
            </Button>
            <DialogCancelButton disabled={mutation.isPending} />
            <Button
              type="submit"
              disabled={
                mutation.isPending ||
                !apps.some((app) => app.id === form.watch("githubAppConfigId"))
              }
            >
              <span>
                {mutation.isPending ? "Creating…" : "Create and sync"}
              </span>
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <OpenAppaGithubAppRequirements />
          <div className="space-y-2">
            <Label htmlFor="new-appa-repo">Repository</Label>
            <p className="text-xs text-muted-foreground">
              Use the account where the App is installed and a new repository
              name, or retry one created by an earlier attempt.
            </p>
            <Input
              id="new-appa-repo"
              placeholder="organization/openappa-policy"
              {...form.register("repo", {
                required: true,
                pattern: /^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/,
              })}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="new-appa-app">Connected GitHub App</Label>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto shrink-0 px-0 py-0 text-xs"
                onClick={() => setCredentialStep("define")}
              >
                <span>Set up a new App</span>
              </Button>
            </div>
            <Select
              value={form.watch("githubAppConfigId")}
              onValueChange={(value) =>
                form.setValue("githubAppConfigId", value, { shouldDirty: true })
              }
            >
              <SelectTrigger id="new-appa-app" className="w-full">
                <RuntimeCredentialIcon
                  icon={
                    apps.find(
                      (app) => app.id === form.watch("githubAppConfigId"),
                    )?.icon ?? "logo:github"
                  }
                  className="size-4"
                  size={16}
                />
                <span className="min-w-0 flex-1 text-left">
                  <SelectValue placeholder="Select an existing App" />
                </span>
              </SelectTrigger>
              <SelectContent
                position="popper"
                className="w-[var(--radix-select-trigger-width)]"
              >
                {apps.map((app) => (
                  <SelectItem
                    key={app.id}
                    value={app.id}
                    icon={
                      <RuntimeCredentialIcon
                        icon={app.icon ?? "logo:github"}
                        className="size-4"
                        size={16}
                      />
                    }
                  >
                    {app.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!apps.length && (
              <InlineNotice variant="info">
                <InlineNoticeText>
                  Set up and connect an organization GitHub App before creating
                  a repository.
                </InlineNoticeText>
              </InlineNotice>
            )}
          </div>
          {mutation.error && (
            <InlineNotice variant="error">
              <AlertTriangle aria-hidden />
              <span className="font-medium">Couldn&apos;t finish setup</span>
              <InlineNoticeText className="basis-full pl-5">
                {mutation.error.message}
              </InlineNoticeText>
            </InlineNotice>
          )}
        </div>
      </StandardFormDialog>
      {credentialStep === "define" && (
        <RuntimeCredentialDefinitionDialog
          definition={null}
          initialKind="github_app"
          initialScope="organization"
          initialValues={OPENAPPA_GITHUB_CREDENTIAL_INITIAL_VALUES}
          setupNotice={<OpenAppaGithubAppRequirements />}
          hideProvidedBy
          backLabel="Back to repository"
          size="medium"
          onClose={() => setCredentialStep("repository")}
          onCreated={(id) => {
            setNewCredentialId(id);
            form.setValue("githubAppConfigId", id, { shouldDirty: true });
            setCredentialStep("connect");
          }}
        />
      )}
      {credentialStep === "connect" && newCredential && (
        <RuntimeCredentialConnectionDialog
          definition={newCredential}
          scope="organization"
          onClose={() => setCredentialStep("repository")}
        />
      )}
    </>
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
          : source?.repo
            ? "public"
            : "",
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
        title={
          source?.repo ? "Edit GitHub source" : "Connect OpenAPPA to GitHub"
        }
        description="Read the policy from an existing GitHub repository. Once connected, its appa.toml becomes your active policy."
        size="medium"
        className="w-[calc(100%-2rem)] sm:max-w-xl"
        bodyClassName="space-y-5"
        onSubmit={submit}
        footer={
          <>
            <DialogCancelButton disabled={mutation.isPending} />
            <Button
              type="submit"
              disabled={mutation.isPending || !form.watch("credential")}
            >
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
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="appa-credential">GitHub App</Label>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto shrink-0 px-0 py-0 text-xs"
              onClick={() => setCredentialStep("define")}
            >
              Set up a new App
            </Button>
          </div>
          <Select
            value={form.watch("credential")}
            onValueChange={(value) =>
              form.setValue("credential", value, { shouldDirty: true })
            }
          >
            <SelectTrigger id="appa-credential" className="w-full">
              <RuntimeCredentialIcon
                icon={
                  apps.find(
                    (app) => `app:${app.id}` === form.watch("credential"),
                  )?.icon ?? "logo:github"
                }
                className="size-4"
                size={16}
              />
              <span className="min-w-0 flex-1 text-left">
                <SelectValue placeholder="Select a connected App" />
              </span>
            </SelectTrigger>
            <SelectContent
              position="popper"
              className="w-[var(--radix-select-trigger-width)]"
            >
              {apps.map((app) => (
                <SelectItem
                  key={app.id}
                  value={`app:${app.id}`}
                  icon={
                    <RuntimeCredentialIcon
                      icon={app.icon ?? "logo:github"}
                      className="size-4"
                      size={16}
                    />
                  }
                >
                  {app.name}
                </SelectItem>
              ))}
              {source?.githubPatId &&
                pats.map((pat) => (
                  <SelectItem key={pat.id} value={`pat:${pat.id}`}>
                    {pat.name}
                  </SelectItem>
                ))}
              {source?.repo && (
                <SelectItem value="public">Public repository</SelectItem>
              )}
            </SelectContent>
          </Select>
          {!apps.length && (
            <InlineNotice variant="info">
              <InlineNoticeText>
                Connect an organization GitHub App to review policy changes
                through pull requests.
              </InlineNoticeText>
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
      </StandardFormDialog>
      {credentialStep === "define" && (
        <RuntimeCredentialDefinitionDialog
          definition={null}
          initialKind="github_app"
          initialScope="organization"
          initialValues={OPENAPPA_GITHUB_CREDENTIAL_INITIAL_VALUES}
          setupNotice={<OpenAppaGithubAppRequirements />}
          hideProvidedBy
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
