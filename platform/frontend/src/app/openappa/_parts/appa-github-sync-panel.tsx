"use client";

import {
  type archestraApiTypes,
  DocsPage,
  getDocsUrl,
  type gitWebUrls,
} from "@archestra/shared";
import { AlertTriangle, ExternalLink, GitBranch } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExternalDocsLink } from "@/components/external-docs-link";
import {
  GitSourceBranch,
  GitSourceCard,
  GitSourceError,
  GitSourceNotice,
} from "@/components/git/git-source-card";
import { OpenAppaGithubAppRequirements } from "@/components/openappa-github-app-requirements";
import { QueryLoadError } from "@/components/query-load-error";
import { RuntimeCredentialConnectionDialog } from "@/components/runtime-credential-connection-dialog";
import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";
import { DeploymentSettingRow } from "@/components/settings/deployment-setting-row";
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
import { getVisibleDocsUrl } from "@/lib/docs/docs";
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
import { appaGitHost } from "./appa-git-host";
import { GithubSyncSetupDialog } from "./github-sync-setup-dialog";
import { SelfServiceSetupDialog } from "./self-service-setup-dialog";

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
  const {
    source,
    enabled,
    hasPolicy,
    validationDirectory,
    githubWebUrl,
    selfService,
  } = query.data;
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
                          {connected ? "Edit" : `Reconnect ${git.label}`}
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
                  <SelfServiceRow
                    source={source}
                    urls={urls}
                    selfService={selfService}
                    canManage={canManage === true}
                  />
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
              selfService: source.selfService,
              selfServiceDirectory: source.selfServiceDirectory,
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

/**
 * The repository's protection for server rules files: the branch ruleset
 * the administrator imports, which Archestra reads at each sync.
 */
/**
 * The self-service switch: whether each MCP server's editors change its own
 * rules through pull requests. Locked while the environment variable sets
 * it, and off for a source without a GitHub App, which posts no check.
 */
function SelfServiceRow({
  source,
  urls,
  selfService,
  canManage,
}: {
  source: Source;
  /** Browser links into the repository, for the branch and the folder. */
  urls: ReturnType<typeof gitWebUrls> | null;
  selfService: archestraApiTypes.GetAppaGithubSyncResponses["200"]["selfService"];
  canManage: boolean;
}) {
  const appName = useAppName();
  const eligible = !!source.githubAppConfigId;
  const [setup, setSetup] = useState(false);
  const description = (
    <>
      {eligible
        ? "MCP owners can manage MCP Guardrails. An additional GitHub App permission is added to ensure the related pull requests are checked."
        : "Connect the policy repository through a GitHub App so MCP owners can manage MCP Guardrails."}{" "}
      <SelfServiceDocsLink />
    </>
  );
  return (
    <GitSourceNotice>
      <div className="space-y-2">
        {selfService.environment ? (
          <DeploymentSettingRow
            compact
            title="MCP Guardrails Self-Service"
            description={description}
            value={selfService.enabled ? "enabled" : "disabled"}
            disabled
            environmentVariable={selfService.environment.variable}
            options={[
              { value: "enabled", label: "On" },
              { value: "disabled", label: "Off" },
            ]}
            onChange={() => {}}
          />
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium">MCP Guardrails Self-Service</p>
              <p className="text-xs text-muted-foreground">{description}</p>
            </div>
            {/* Once on, Edit on the card changes or turns it off. */}
            {selfService.enabled ? null : (
              <Button
                size="sm"
                type="button"
                className="shrink-0"
                disabled={!canManage || !eligible}
                onClick={() => setSetup(true)}
              >
                <span>Enable</span>
              </Button>
            )}
          </div>
        )}
        {selfService.leftoverRule ? (
          <p className="text-xs text-muted-foreground">
            A branch {hostLink(selfService.leftoverRule.url, "ruleset")} still
            requires the {selfService.leftoverRule.checkName} check. {appName}{" "}
            posts it as skipped on every pull request until you remove the rule,
            or turn self-service on again.
          </p>
        ) : null}
        {selfService.enabled ? (
          <RepositoryProtection
            policyPath={source.path ?? "appa.toml"}
            branchUrl={urls?.tree(source.ref ?? "HEAD") ?? null}
            folderUrl={(folder) =>
              urls?.tree(
                source.ref ?? "HEAD",
                policyFolderOf(source.path ?? "appa.toml", folder),
              ) ?? null
            }
            onFinishSetup={canManage ? () => setSetup(true) : undefined}
          />
        ) : null}
      </div>
      {setup ? (
        <SelfServiceSetupDialog
          open
          onOpenChange={setSetup}
          policyPath={source.path ?? "appa.toml"}
          directory={selfService.directory}
          alreadyOn={selfService.enabled}
        />
      ) : null}
    </GitSourceNotice>
  );
}

/** How self-service works, on the Git sync docs page; the row says only what it is. */
function SelfServiceDocsLink() {
  const href = getVisibleDocsUrl(
    getDocsUrl(
      DocsPage.PlatformAiToolGuardrailsGitSync,
      "mcp-guardrails-self-service",
    ),
  );
  if (!href) return null;
  return (
    <ExternalDocsLink
      href={href}
      showIcon={false}
      className="text-primary underline underline-offset-2 hover:text-primary/80"
    >
      Learn more
    </ExternalDocsLink>
  );
}

/** A folder beside the policy file, as a repository path. */
function policyFolderOf(policyPath: string, folder: string): string {
  const slash = policyPath.lastIndexOf("/");
  return slash < 0 ? folder : `${policyPath.slice(0, slash)}/${folder}`;
}

function RepositoryProtection({
  policyPath,
  branchUrl,
  folderUrl,
  onFinishSetup,
}: {
  policyPath: string;
  /** The synced branch on the host, for the ruleset sentence. */
  branchUrl: string | null;
  /** The servers' folder on the host, for the include sentence. */
  folderUrl: (folder: string) => string | null;
  /** Opens the self-service setup again, for a part that is still missing. */
  onFinishSetup?: () => void;
}) {
  const { data } = useAppaRepositoryProtection(true);
  if (!data) return null;
  const policyFile = policyPath.slice(policyPath.lastIndexOf("/") + 1);
  const unfinished =
    data.branchRules.state !== "active" || data.include.state === "missing";
  return (
    <>
      <p className="text-xs text-muted-foreground">
        {protectionSentence({
          rules: data.branchRules,
          checkName: data.checkName,
          branchUrl,
          app: data.app,
        })}
      </p>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {includeSentence(data.include, policyFile, folderUrl)}
        {unfinished && onFinishSetup ? (
          <Button
            size="xs"
            type="button"
            variant="outline"
            onClick={onFinishSetup}
          >
            Finish setup
          </Button>
        ) : null}
      </p>
    </>
  );
}

/**
 * One sentence on the include that makes the servers' files apply: where
 * they live, or the pull request that adds the line, or that it is missing.
 */
function includeSentence(
  include: Protection["include"],
  policyFile: string,
  folderUrl: (folder: string) => string | null,
): ReactNode {
  const entry = <code>{`${include.folder}/*.toml`}</code>;
  switch (include.state) {
    case "included":
      return (
        <span>
          MCP servers&apos; policy files go to{" "}
          {hostLink(folderUrl(include.folder), `${include.folder}/`)}
        </span>
      );
    case "pull_open":
      return (
        <span>
          <a
            href={include.pull?.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground underline underline-offset-4 hover:text-foreground/80"
          >
            Pull request #{include.pull?.number}
          </a>{" "}
          adds {entry} to {policyFile}. Merge it and re-sync.
        </span>
      );
    case "unknown":
      return (
        <span>
          Could not read the policy repository to tell whether {policyFile}{" "}
          includes {entry}. Try again in a moment.
        </span>
      );
    default:
      return (
        <span>
          {policyFile} does not include {entry} yet.
        </span>
      );
  }
}

/**
 * One sentence on the ruleset: on, with a link to it, or why not yet. The
 * check the App cannot post comes first, since a rule that requires it holds
 * every pull request.
 */
/** A link into the repository on its host, or the text alone without one. */
function hostLink(href: string | null | undefined, text: string): ReactNode {
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-foreground underline underline-offset-4 hover:text-foreground/80"
    >
      {text}
    </a>
  ) : (
    <span>{text}</span>
  );
}

function protectionSentence({
  rules,
  checkName,
  branchUrl,
  app,
}: {
  rules: Protection["branchRules"];
  checkName: string;
  branchUrl: string | null;
  app: Protection["app"];
}): ReactNode {
  const ruleset = hostLink(rules.url, "ruleset");
  // The App by its own name, linked to its page; "GitHub App" before it is known.
  const githubApp = app ? (
    <>{hostLink(app.url, app.name)} App</>
  ) : (
    <span>GitHub App</span>
  );
  if (rules.checkRule === "unposted")
    return (
      <>
        The Self-service branch protection {ruleset} holds pull requests until
        the {githubApp} can post the check.
      </>
    );
  switch (rules.state) {
    case "active":
      return (
        <>
          {hostLink(rules.url, "Ruleset")} protects the policy on the{" "}
          {hostLink(branchUrl, "branch")}
        </>
      );
    case "incomplete":
      return (
        <>
          The Self-service branch protection {ruleset} needs a change:{" "}
          {rules.detail}
        </>
      );
    case "missing":
      return (
        <>
          No branch ruleset requires the {checkName} check yet. Import it with
          Finish setup.
        </>
      );
    case "needs_permission":
      return (
        <>
          The Self-service branch protection ruleset waits for the {githubApp}
          &apos;s Checks permission.
        </>
      );
    default:
      return (
        <>
          The Self-service branch protection ruleset could not be checked
          {rules.detail ? <span>: {rules.detail}</span> : <span>.</span>}
        </>
      );
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
