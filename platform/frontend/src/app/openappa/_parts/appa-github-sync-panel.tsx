"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  AlertTriangle,
  ExternalLink,
  GitBranch,
  Github,
  GitPullRequestArrow,
  RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { OpenAppaGithubAppRequirements } from "@/components/openappa-github-app-requirements";
import { QueryLoadError } from "@/components/query-load-error";
import { RuntimeCredentialConnectionDialog } from "@/components/runtime-credential-connection-dialog";
import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";
import { RuntimeCredentialDefinitionDialog } from "@/components/settings/runtime-credential-definition-dialog";
import { SettingsBlock } from "@/components/settings/settings-block";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAcceptHeldPull } from "@/lib/openappa-batteries.query";
import { OPENAPPA_GITHUB_CREDENTIAL_INITIAL_VALUES } from "@/lib/openappa-github-credential";
import {
  useAppaGithubSync,
  useConfigureAppaGithubSync,
  useUpdateAppaGithubSync,
} from "@/lib/openappa-github-sync.query";
import { useRuntimeCredentials } from "@/lib/runtime-credentials.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { GithubSyncSetupDialog } from "./github-sync-setup-dialog";

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
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  // Approving a held pull performs what it was held for, as on the batteries page.
  const { data: canEditPolicy } = useHasPermissions({
    openappaPolicy: ["update"],
  });
  const { data: canBindCredentials } = useHasPermissions({
    openappaPolicy: ["update"],
    credential: ["update"],
  });
  const acceptHeld = useAcceptHeldPull();
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  // The guardrails agent links here with ?setup=github-sync rather than setting
  // sync up in chat. Open setup once, when it can start, and drop the
  // parameter so a reload doesn't reopen it.
  const router = useRouter();
  const pathname = usePathname();
  const setupRequested = useSearchParams().get("setup") === "github-sync";
  const canStartSetup =
    !!query.data?.enabled && !query.data.source?.repo && canManage === true;
  useEffect(() => {
    if (!setupRequested || !query.data || canManage === undefined) return;
    if (canStartSetup) setCreating(true);
    router.replace(pathname, { scroll: false });
  }, [setupRequested, canStartSetup, canManage, query.data, router, pathname]);
  if (query.isPending) return <Skeleton className="mb-6 h-32 w-full" />;
  if (query.isError || !query.data)
    return (
      <QueryLoadError
        title="Could not load APPA sync"
        onRetry={() => query.refetch()}
        className="mb-6 h-auto"
      />
    );
  const { source, enabled, hasPolicy, validationDirectory, githubWebUrl } =
    query.data;
  const lastChecked = source?.lastSyncedAt
    ? `Last checked ${formatRelativeTimeFromNow(source.lastSyncedAt).toLowerCase()}`
    : source?.interval
      ? "Waiting for the first sync"
      : "Automatic updates stopped";
  const connected = !!source?.interval;
  // A held pull is not a failure: it waits for someone here to approve it.
  const held = !!source?.heldReasons.length;
  const mayApprove = source?.heldReasons.includes("changes_credentials")
    ? canBindCredentials === true
    : canEditPolicy === true;
  const status = !enabled
    ? "Disabled"
    : held
      ? "Needs approval"
      : source?.lastSyncError
        ? "Sync failed"
        : connected && source?.setupPullRequestNumber
          ? "Waiting for setup PR"
          : connected
            ? "Connected"
            : hasPolicy
              ? "Sync stopped"
              : null;
  return (
    <>
      <SettingsBlock
        title={
          <span className="inline-flex items-center gap-2">
            GitHub sync
            {/* No badge until sync is set up: there is no state to report. */}
            {status && (
              <Badge
                variant={
                  source?.lastSyncError && !held ? "destructive" : "outline"
                }
              >
                {status}
              </Badge>
            )}
          </span>
        }
        description={
          connected
            ? "Your policy syncs both ways: changes merged in GitHub apply here, and changes made here open a pull request."
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
                <div className="flex flex-wrap items-center gap-4 px-4 py-3">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
                      <Github className="size-5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                      <a
                        className="inline-flex max-w-full items-center gap-2 text-sm leading-5 font-medium hover:underline underline-offset-4"
                        href={`${githubWebUrl}/${source.repo}/blob/${encodeURIComponent(source.ref ?? "HEAD")}/${source.path.split("/").map(encodeURIComponent).join("/")}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <span className="truncate">{source.repo}</span>
                        <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
                      </a>
                      <div
                        className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"
                        aria-live="polite"
                      >
                        <span className="inline-flex items-center gap-1">
                          <GitBranch className="size-3.5" />
                          {source.ref ?? "Default branch"}
                        </span>
                        <span className="font-mono">{source.path}</span>
                        {source.sourceCommit ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <a
                                className="font-mono underline underline-offset-4"
                                href={`${githubWebUrl}/${source.repo}/commit/${source.sourceCommit}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {source.sourceCommit.slice(0, 7)}
                              </a>
                            </TooltipTrigger>
                            <TooltipContent>{lastChecked}</TooltipContent>
                          </Tooltip>
                        ) : (
                          <span>{lastChecked}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  {connected && (
                    <div className="ml-auto flex items-center gap-2">
                      {canManage && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="outline"
                              size="xs"
                              disabled={update.isPending}
                              onClick={() => update.mutate({ action: "sync" })}
                            >
                              <RefreshCw
                                className={cn(
                                  "size-3.5",
                                  update.isPending &&
                                    update.variables?.action === "sync" &&
                                    "animate-spin",
                                )}
                              />
                              <span>
                                {update.isPending &&
                                update.variables?.action === "sync"
                                  ? "Syncing…"
                                  : "Sync now"}
                              </span>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {source.interval
                              ? `Checks ${intervals[source.interval].toLowerCase()}. ${lastChecked}.`
                              : `${lastChecked}.`}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  )}
                </div>
                {connected && source.setupPullRequestNumber && (
                  <div className="px-4 pb-4">
                    <InlineNotice variant="info">
                      <GitBranch aria-hidden />
                      <span className="font-medium">
                        Merge your initial policy
                      </span>
                      <InlineNoticeText className="flex-1">
                        Your current policy stays active until it merges.
                      </InlineNoticeText>
                      <a
                        href={`${githubWebUrl}/${source.repo}/pull/${source.setupPullRequestNumber}`}
                        target="_blank"
                        rel="noreferrer"
                        data-slot="inline-notice-action"
                        className="ml-auto inline-flex shrink-0 items-center gap-0.5 font-medium underline-offset-4 hover:underline"
                      >
                        <span>Review and merge PR</span>
                        <ExternalLink className="size-3" aria-hidden />
                      </a>
                    </InlineNotice>
                  </div>
                )}
                {held ? (
                  <div className="px-4 pb-4">
                    <InlineNotice variant="warning">
                      <GitPullRequestArrow className="size-4 shrink-0" />
                      <span className="font-medium">
                        Repository changes need approval
                      </span>
                      <InlineNoticeText className="flex-1">
                        {source.lastSyncError} Your current policy stays active
                        until you approve.{" "}
                        <Link
                          href="/openappa/batteries"
                          className="font-medium underline underline-offset-4"
                        >
                          See batteries
                        </Link>
                      </InlineNoticeText>
                      {mayApprove && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-auto"
                          disabled={acceptHeld.isPending}
                          onClick={() => acceptHeld.mutate()}
                        >
                          <span>Approve</span>
                        </Button>
                      )}
                    </InlineNotice>
                  </div>
                ) : source.lastSyncError ? (
                  <div className="px-4 pb-4">
                    <InlineNotice variant="error">
                      <AlertTriangle className="size-4 shrink-0" />
                      <span className="font-medium">Could not sync policy</span>
                      <InlineNoticeText>
                        {source.lastSyncError}
                      </InlineNoticeText>
                    </InlineNotice>
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t bg-muted/30 px-4 py-2">
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {hasPolicy
                      ? connected
                        ? "Conversations already running keep the policy they started with."
                        : "Automatic updates are stopped. Your last synced policy stays active."
                      : "The current policy stays active until a valid GitHub policy is accepted."}
                  </p>
                  {canManage && (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => setEditing(true)}
                      >
                        {connected ? "Edit source" : "Reconnect GitHub"}
                      </Button>
                      {connected && (
                        <Button
                          variant="outline"
                          size="xs"
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
      {editing &&
        // App-backed sources edit in the setup flow, filled in; a PAT or a
        // public source keeps the plain form, which the flow does not offer.
        (source?.githubAppConfigId && source.repo && source.path ? (
          <GithubSyncSetupDialog
            onOpenChange={setEditing}
            editing={{
              repo: source.repo,
              ref: source.ref,
              path: source.path,
              interval: source.interval ?? "1h",
              validationDirectory,
              githubAppConfigId: source.githubAppConfigId,
              githubWebUrl,
            }}
          />
        ) : (
          <OpenAppaSourceForm source={source} onOpenChange={setEditing} />
        ))}
      {creating && <GithubSyncSetupDialog onOpenChange={setCreating} />}
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
        // Validations stay in the source's folder (traces by default), and the
        // sync interval is changed on the panel, so neither is asked here.
        interval: source?.interval ?? "1h",
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
            <Label htmlFor="appa-credential">GitHub credential</Label>
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
                Publishing pull requests requires a connected GitHub App or a
                PAT with Contents and Pull requests read/write permissions.
              </InlineNoticeText>
            </InlineNotice>
          )}
        </div>
        {mutation.error && (
          <InlineNotice variant="error">
            <AlertTriangle />
            <span className="font-medium">Could not save GitHub source</span>
            <InlineNoticeText>{mutation.error.message}</InlineNoticeText>
          </InlineNotice>
        )}
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
