"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { AlertTriangle, ExternalLink, GitBranch } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  GitSourceBranch,
  GitSourceCard,
  GitSourceError,
  GitSourceNotice,
} from "@/components/git/git-source-card";
import { openGithubWindow } from "@/components/github-app-setup/github-app-window";
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
import { useAppName } from "@/lib/hooks/use-app-name";
import { OPENAPPA_GITHUB_CREDENTIAL_INITIAL_VALUES } from "@/lib/openappa-github-credential";
import {
  useAppaGithubSync,
  useAppaRepositoryProtection,
  useConfigureAppaGithubSync,
  useUpdateAppaGithubSync,
} from "@/lib/openappa-github-sync.query";
import { useRuntimeCredentials } from "@/lib/runtime-credentials.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { appaGitHost } from "./appa-git-host";
import {
  GITHUB_WINDOW,
  GithubSyncSetupDialog,
} from "./github-sync-setup-dialog";

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
        error={query.error}
        onRetry={() => query.refetch()}
        className="mb-6 h-auto"
      />
    );
  const { source, enabled, hasPolicy, validationDirectory, githubWebUrl } =
    query.data;
  const git = appaGitHost(query.data);
  const urls = source?.repo ? git.urls(source.repo) : null;
  const lastChecked = source?.lastSyncedAt
    ? `Last checked ${formatRelativeTimeFromNow(source.lastSyncedAt).toLowerCase()}`
    : source?.interval
      ? "Waiting for the first sync"
      : "Automatic updates stopped";
  const connected = !!source?.interval;
  const status = !enabled
    ? "Disabled"
    : source?.lastSyncError
      ? "Sync failed"
      : connected && source?.setupPullRequestNumber
        ? `Waiting for setup ${git.changeRequestShort}`
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
            <span>Git sync</span>
            {/* No badge until sync is set up: there is no state to report. */}
            {status && (
              <Badge
                variant={source?.lastSyncError ? "destructive" : "outline"}
              >
                {status}
              </Badge>
            )}
          </span>
        }
        description={
          connected
            ? `Your policy syncs both ways: changes merged in ${git.label} apply here, and changes made here open a ${git.changeRequest}.`
            : "Keep your policy in GitHub or GitLab and review every change."
        }
        control={
          enabled && !source?.repo && canManage ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <GitBranch className="size-4" />
              <span>Set up Git sync</span>
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
              <GitSourceCard
                provider={git.provider}
                repo={source.repo}
                href={`${githubWebUrl}/${source.repo}${git.provider === "gitlab" ? "/-" : ""}/blob/${encodeURIComponent(source.ref ?? "HEAD")}/${source.path.split("/").map(encodeURIComponent).join("/")}`}
                details={
                  <>
                    <GitSourceBranch branch={source.ref} />
                    <span className="font-mono">{source.path}</span>
                    {source.sourceCommit ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <a
                            className="font-mono underline underline-offset-4"
                            href={urls?.commit(source.sourceCommit)}
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
                  </>
                }
                sync={
                  connected && canManage
                    ? {
                        onClick: () => update.mutate({ action: "sync" }),
                        pending:
                          update.isPending &&
                          update.variables?.action === "sync",
                        tooltip: source.interval
                          ? `Checks ${intervals[source.interval].toLowerCase()}. ${lastChecked}.`
                          : `${lastChecked}.`,
                      }
                    : undefined
                }
                footer={
                  hasPolicy
                    ? connected
                      ? "Conversations already running keep the policy they started with."
                      : "Automatic updates are stopped. Your last synced policy stays active."
                    : `The current policy stays active until a valid ${git.label} policy is accepted.`
                }
                actions={
                  canManage ? (
                    <>
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => setEditing(true)}
                      >
                        <span>
                          {connected ? "Edit source" : `Reconnect ${git.label}`}
                        </span>
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
                    </>
                  ) : undefined
                }
              >
                {connected && source.setupPullRequestNumber && (
                  <GitSourceNotice>
                    <InlineNotice variant="info">
                      <GitBranch aria-hidden />
                      <span className="font-medium">
                        Merge your initial policy
                      </span>
                      <InlineNoticeText className="flex-1">
                        Your current policy stays active until it merges.
                      </InlineNoticeText>
                      <a
                        href={urls?.changeRequest(
                          source.setupPullRequestNumber,
                        )}
                        target="_blank"
                        rel="noreferrer"
                        data-slot="inline-notice-action"
                        className="ml-auto inline-flex shrink-0 items-center gap-0.5 font-medium underline-offset-4 hover:underline"
                      >
                        <span>Review and merge {git.changeRequestShort}</span>
                        <ExternalLink className="size-3" aria-hidden />
                      </a>
                    </InlineNotice>
                  </GitSourceNotice>
                )}
                {source.lastSyncError ? (
                  <GitSourceError
                    title="Could not sync policy"
                    message={source.lastSyncError}
                  />
                ) : null}
                {connected && !source.setupPullRequestNumber && (
                  <RepositoryProtection />
                )}
              </GitSourceCard>
            ) : null}
          </div>
        )}
      </SettingsBlock>
      {editing &&
        // App- and GitLab-token-backed sources edit in the setup flow, filled
        // in; a PAT or a public source keeps the plain form, which the flow
        // does not offer.
        ((source?.githubAppConfigId || source?.gitlabTokenId) &&
        source.repo &&
        source.path ? (
          <GithubSyncSetupDialog
            onOpenChange={setEditing}
            editing={{
              provider: source.gitlabTokenId ? "gitlab" : "github",
              credentialId: (source.gitlabTokenId ??
                source.githubAppConfigId) as string,
              repo: source.repo,
              ref: source.ref,
              path: source.path,
              interval: source.interval ?? "1h",
              validationDirectory,
              webUrl: githubWebUrl,
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
        description="The last accepted policy stays active. Automatic updates stop until you reconnect."
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

type Protection = NonNullable<
  archestraApiTypes.GetAppaRepositoryProtectionResponses["200"]
>;

type ProtectionView = {
  status: string;
  tone: "ok" | "pending" | "problem" | "off";
  link?: { href: string; label: string };
  detail?: string;
};

/**
 * The repository's protection for server rules files: the branch ruleset
 * Archestra keeps in line at each sync.
 */
function RepositoryProtection() {
  const { data, refetch, isFetching } = useAppaRepositoryProtection(true);
  const appName = useAppName();
  if (!data) return null;
  const missing = (data.app?.permissions ?? []).filter(
    (permission) => !permission.granted,
  );
  const rows: Array<{ label: string; view: ProtectionView }> = [
    {
      label: "Branch rules",
      view: branchRulesView(data.branchRules, appName, data.checkName),
    },
  ];
  return (
    <GitSourceNotice>
      <div className="space-y-2 rounded-md border p-3 text-sm">
        <p className="font-medium">Repository protection</p>
        <dl className="space-y-2">
          {rows.map(({ label, view }) => (
            <div key={label} className="flex flex-wrap gap-x-3 gap-y-1">
              <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
              <dd className="min-w-0 flex-1 space-y-1">
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      view.tone === "ok" && "bg-emerald-500",
                      view.tone === "pending" && "bg-amber-500",
                      view.tone === "problem" && "bg-destructive",
                      view.tone === "off" && "bg-muted-foreground/40",
                    )}
                  />
                  <span>{view.status}</span>
                  {view.link && (
                    <a
                      href={view.link.href}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-0.5 font-medium underline-offset-4 hover:underline"
                    >
                      <span>{view.link.label}</span>
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                  )}
                </span>
                {view.detail && (
                  <p className="text-muted-foreground">{view.detail}</p>
                )}
              </dd>
            </div>
          ))}
        </dl>
        {data.app && missing.length > 0 && (
          <InlineNotice variant="warning">
            <AlertTriangle className="size-4 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1 space-y-2">
              <InlineNoticeText>
                The GitHub App lacks{" "}
                {missing.map((permission, index) => (
                  <span key={permission.name}>
                    {index > 0 &&
                      (index === missing.length - 1 ? " and " : ", ")}
                    <strong>{APP_PERMISSION_LABELS[permission.name]}</strong> (
                    {APP_PERMISSION_PURPOSES[permission.name]})
                  </span>
                ))}
                . Grant {missing.length === 1 ? "it" : "them"} on the App, as
                read and write, then accept the change on the installation.
              </InlineNoticeText>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  type="button"
                  onClick={() => {
                    openGithubWindow(
                      data.app?.settingsUrl ?? "",
                      GITHUB_WINDOW,
                    );
                  }}
                >
                  Update App permissions
                  <ExternalLink className="size-3" aria-hidden />
                </Button>
                {data.app.installationUrl && (
                  <a
                    href={data.app.installationUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 font-medium underline-offset-4 hover:underline"
                  >
                    <span>Accept on the installation</span>
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                )}
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  disabled={isFetching}
                  onClick={() => {
                    void refetch();
                  }}
                >
                  Check again
                </Button>
              </div>
            </div>
          </InlineNotice>
        )}
      </div>
    </GitSourceNotice>
  );
}

const APP_PERMISSION_LABELS = {
  contents: "Contents",
  pull_requests: "Pull requests",
  checks: "Checks",
  administration: "Administration",
} as const;

const APP_PERMISSION_PURPOSES = {
  contents: "reads the policy and writes proposals",
  pull_requests: "finds and opens pull requests",
  checks: "posts the policy check",
  administration: "keeps the branch rules",
} as const;

function branchRulesView(
  rules: Protection["branchRules"],
  appName: string,
  checkName: string,
): ProtectionView {
  const link = rules.url
    ? { href: rules.url, label: "View ruleset" }
    : undefined;
  // Kept as an administrator added them on GitHub; each one skips the rules.
  const bypass = rules.bypassActors
    ? rules.bypassActors === 1
      ? "One bypass entry on GitHub can merge without these rules."
      : `${rules.bypassActors} bypass entries on GitHub can merge without these rules.`
    : undefined;
  // The check the App cannot post: a rule that requires it holds every pull
  // request, so that comes first; without the rule, merges go on without it.
  const detail = [rules.detail, bypass].filter(Boolean).join(" ") || undefined;
  if (rules.checkRule === "unposted")
    return {
      status: `Pull requests wait on a ${checkName} check the GitHub App cannot post`,
      tone: "problem",
      link,
      detail,
    };
  switch (rules.state) {
    case "active":
      return {
        status:
          rules.checkRule === "omitted"
            ? `Merges need an up-to-date pull request; ${appName} adds the ${checkName} check, which decides who may change each file, once the App may post it`
            : `Merges need an up-to-date pull request that passes the ${checkName} check, which decides who may change each file`,
        tone: "ok",
        link,
        detail,
      };
    case "incomplete":
      return {
        status: `${appName} restores the missing rules at the next sync`,
        tone: "pending",
        link,
        detail,
      };
    case "missing":
      return {
        status: `${appName} creates the ruleset at the next sync`,
        tone: "pending",
      };
    case "disabled":
      return {
        status: "Turned off on GitHub",
        tone: "off",
        link,
        detail: rules.detail,
      };
    case "needs_permission":
      // An App created before Archestra kept rulesets: an opt-in, not a fault.
      return {
        status: "Off until the GitHub App has the Administration permission",
        tone: "off",
        detail: rules.detail,
      };
    case "unavailable":
      return {
        status: "Not available for this repository",
        tone: "problem",
        detail: rules.detail,
      };
    case "unsupported":
      return { status: "Not managed here", tone: "off", detail: rules.detail };
    default:
      return {
        status: "Could not check",
        tone: "problem",
        detail: rules.detail,
      };
  }
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
          backLabel="Back to Git sync"
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
