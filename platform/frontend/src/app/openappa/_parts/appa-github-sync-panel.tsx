"use client";

import {
  type archestraApiTypes,
  DocsPage,
  getDocsUrl,
  type gitWebUrls,
} from "@archestra/shared";
import { AlertTriangle, GitBranch } from "lucide-react";
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
  GitSourceSchedule,
} from "@/components/git/git-source-card";
import { ClickPath } from "@/components/github-app-setup/click-path";
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
import { OPENAPPA_GITHUB_CREDENTIAL_INITIAL_VALUES } from "@/lib/openappa-github-credential";
import {
  useAppaGithubAppGrants,
  useAppaGithubSync,
  useAppaGithubSyncing,
  useAppaRepositoryProtection,
  useConfigureAppaGithubSync,
  useUpdateAppaGithubSync,
} from "@/lib/openappa-github-sync.query";
import { useRuntimeCredentials } from "@/lib/runtime-credentials.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { appaGitHost, isAccessRefusal } from "./appa-git-host";
import {
  FinishSetupHost,
  FinishSetupNotice,
  useFinishSetupPieces,
} from "./finish-setup-dialog";
import {
  DEFAULT_SYNC_INTERVAL,
  GithubSyncSetupDialog,
  SYNC_INTERVAL_LABELS,
  SyncScheduleSelect,
} from "./github-sync-setup-dialog";
import { SelfServiceSetupDialog } from "./self-service-setup-dialog";

type Source = NonNullable<
  archestraApiTypes.GetAppaGithubSyncResponses["200"]["source"]
>;

export function AppaGithubSyncPanel() {
  const query = useAppaGithubSync();
  const update = useUpdateAppaGithubSync();
  const syncing = useAppaGithubSyncing();
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  const pieces = useFinishSetupPieces();
  const showSyncError = useShowSyncError(query.data?.source, pieces);
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
                    {/* The repository link opens the policy file: only a
                        file kept elsewhere than appa.toml at the root is
                        named here. */}
                    {source.path !== "appa.toml" ? (
                      <span className="font-mono">{source.path}</span>
                    ) : null}
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
                    {source.interval ? (
                      <GitSourceSchedule
                        schedule={SYNC_INTERVAL_LABELS[source.interval]}
                      />
                    ) : null}
                  </>
                }
                sync={
                  connected && canManage
                    ? {
                        onClick: () => update.mutate({ action: "sync" }),
                        pending: syncing,
                        tooltip: source.interval
                          ? `Checks ${SYNC_INTERVAL_LABELS[source.interval].toLowerCase()}. ${lastChecked}.`
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
                {connected && pieces ? (
                  <GitSourceNotice>
                    <FinishSetupNotice pieces={pieces} />
                  </GitSourceNotice>
                ) : null}
                {source.lastSyncError && showSyncError ? (
                  <GitSourceError
                    title="Could not sync policy"
                    message={source.lastSyncError}
                  />
                ) : null}
                {connected &&
                // GitHub refusing the App is the Finish setup notice's to say.
                ((query.data.templateFiles?.state === "unavailable" &&
                  !(
                    source.githubAppConfigId &&
                    isAccessRefusal(query.data.templateFiles.detail)
                  )) ||
                  // An access token has no App to grant it Workflows: what
                  // it lacks shows here, not as a Finish setup step.
                  (!source.githubAppConfigId &&
                    (query.data.templateFiles?.state === "needs_permission" ||
                      !!query.data.templateFiles?.withheld?.length))) ? (
                  <GitSourceNotice>
                    <InlineNotice variant="warning">
                      <AlertTriangle aria-hidden />
                      <span className="font-medium">
                        {query.data.templateFiles.state === "unavailable"
                          ? "Repository files could not be checked"
                          : "Repository files could not be updated"}
                      </span>
                      <InlineNoticeText className="flex-1">
                        {query.data.templateFiles.detail ??
                          "Try again at the next sync."}
                      </InlineNoticeText>
                    </InlineNotice>
                  </GitSourceNotice>
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
              interval: source.interval ?? DEFAULT_SYNC_INTERVAL,
              validationDirectory,
              webUrl: githubWebUrl,
              selfService: source.selfService,
              selfServiceDirectory: source.selfServiceDirectory,
              selfServiceAutoMerge: source.selfServiceAutoMerge,
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
      {/* The card stays when its notice goes, so the wizard lives here. */}
      <FinishSetupHost />
    </>
  );
}

type Protection = NonNullable<
  archestraApiTypes.GetAppaRepositoryProtectionResponses["200"]
>;

/**
 * MCP Guardrails Self-Service as a part of the source's settings: whether
 * each MCP server's editors change its own rules through pull requests, the
 * folder their files live in, and whether the GitHub App merges those pull
 * requests. Off for a source without a GitHub App, which posts no check.
 * Locked while an environment variable sets it.
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
  const eligible = !!source.githubAppConfigId;
  const [setup, setSetup] = useState(false);
  const protection = useAppaRepositoryProtection(selfService.enabled);
  const data = selfService.enabled ? (protection.data ?? null) : null;
  const state = setupState(data);
  const heading = (() => {
    if (!selfService.enabled)
      return (
        <span>
          MCP Guardrails Self-Service is{" "}
          <strong className="font-bold">Disabled</strong>
        </span>
      );
    if (state === "unfinished")
      return <span>MCP Guardrails Self-Service is ready to be Enabled</span>;
    // The repository's state decides the word; until it is read, none.
    if (state === "unread") return <span>MCP Guardrails Self-Service</span>;
    return (
      <span>
        MCP Guardrails Self-Service is{" "}
        <strong className="font-bold">Enabled</strong>
      </span>
    );
  })();
  const description = (
    <>
      {eligible
        ? "Lets MCP owners manage their MCPs' Guardrails."
        : "Connect the policy repository through a GitHub App so MCP owners can manage MCP Guardrails."}{" "}
      <SelfServiceDocsLink />
    </>
  );
  const policyPath = source.path ?? "appa.toml";
  const folderUrl =
    data?.include.state === "included"
      ? urls?.tree(
          source.ref ?? "HEAD",
          policyFolderOf(policyPath, selfService.directory),
        )
      : null;
  return (
    <GitSourceNotice>
      <div className="space-y-3">
        {selfService.environment ? (
          <DeploymentSettingRow
            compact
            title="MCP Guardrails Self-Service"
            heading={heading}
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
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0 space-y-1">
              <h3 className="text-sm font-medium leading-5">{heading}</h3>
              <p className="text-sm leading-5 text-muted-foreground">
                {description}
              </p>
            </div>
            {/* Once on, Edit on the card changes or turns it off. */}
            {!selfService.enabled && canManage && eligible ? (
              <Button
                size="xs"
                variant="outline"
                type="button"
                className="shrink-0"
                onClick={() => setSetup(true)}
              >
                <span>Enable</span>
              </Button>
            ) : null}
          </div>
        )}
        {selfService.enabled ? (
          <p className="text-sm leading-5 text-muted-foreground">
            Each MCP server policy file goes to{" "}
            {folderUrl ? (
              hostLink(folderUrl, `${selfService.directory}/`)
            ) : (
              <strong className="font-medium text-foreground">
                {selfService.directory}/
              </strong>
            )}
            .
          </p>
        ) : null}
        {selfService.enabled ? (
          <AutoMergeStatus autoMerge={selfService.autoMerge} />
        ) : null}
        {selfService.leftoverRule ? (
          <p className="text-sm leading-5 text-muted-foreground">
            {hostLink(selfService.leftoverRule.url, "Ruleset")} still requires
            the{" "}
            {hostLink(
              getVisibleDocsUrl(
                getDocsUrl(
                  DocsPage.PlatformAiToolGuardrailsGitSync,
                  "the-check-and-the-ruleset",
                ),
              ),
              "guardrails check",
            )}
            .
          </p>
        ) : null}
        {data ? (
          <RepositoryState
            data={data}
            state={state}
            policyPath={policyPath}
            branchUrl={urls?.tree(source.ref ?? "HEAD") ?? null}
          />
        ) : null}
      </div>
      {setup ? (
        <SelfServiceSetupDialog
          open
          onOpenChange={setSetup}
          policyPath={policyPath}
          directory={selfService.directory}
          alreadyOn={selfService.enabled}
        />
      ) : null}
    </GitSourceNotice>
  );
}

/**
 * Whether the GitHub App merges each self-served pull request once its check
 * passes, in either state. The setting lives in the wizard's Self-service
 * step; the card says only what holds, and which variable holds it.
 */
function AutoMergeStatus({
  autoMerge,
}: {
  autoMerge: archestraApiTypes.GetAppaGithubSyncResponses["200"]["selfService"]["autoMerge"];
}) {
  return (
    <p className="text-sm leading-5 text-muted-foreground">
      Auto-merge is{" "}
      <strong className="font-medium text-foreground">
        {autoMerge.enabled ? "Enabled" : "Disabled"}
      </strong>
      .{" "}
      {autoMerge.enabled
        ? "Admitted self-service pull requests merge automatically."
        : "Self-service pull requests have to be merged manually."}
      {autoMerge.environment ? (
        <span>
          {" "}
          Set with{" "}
          <code className="font-mono">{autoMerge.environment.variable}</code>.
        </span>
      ) : null}
    </p>
  );
}

/**
 * Whether the card shows a failed sync's error. Around the App's
 * permissions the Finish setup notice is the one notice, so for a source
 * that syncs through an App a failure shows only once GitHub has said,
 * after the failure was seen, what the App holds, and only if it holds
 * everything. The order the two answers arrive in therefore never puts the
 * error on screen first. The syncs that fail right after a grant are held
 * back too, since GitHub takes a moment to honour it. A sync that fails
 * once that moment has passed is a failure of its own, and shows.
 */
function useShowSyncError(
  source: Source | null | undefined,
  pieces: ReturnType<typeof useFinishSetupPieces>,
): boolean {
  const connected = !!source?.interval;
  const viaApp = connected && !!source?.githubAppConfigId;
  const grants = useAppaGithubAppGrants(viaApp);
  const waitsForPermissions = connected && !!pieces?.permissions.length;
  // When the permissions stopped waiting: failures stay held for a while.
  const [waited, setWaited] = useState(waitsForPermissions);
  const [settlesAt, setSettlesAt] = useState(0);
  if (waited !== waitsForPermissions) {
    setWaited(waitsForPermissions);
    if (!waitsForPermissions) setSettlesAt(Date.now() + GRANT_SETTLE_MS);
  }
  useEffect(() => {
    if (!settlesAt) return;
    const timer = window.setTimeout(
      () => setSettlesAt(0),
      Math.max(0, settlesAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [settlesAt]);
  const settling = settlesAt > 0;
  const failedAt = source?.lastSyncError ? (source.lastSyncedAt ?? "") : null;
  // When this failure was first seen here.
  const [seen, setSeen] = useState<{ failedAt: string; at: number } | null>(
    null,
  );
  if (failedAt !== null && seen?.failedAt !== failedAt)
    setSeen({ failedAt, at: Date.now() });
  // GitHub's answer on the permissions, read after the failure was seen;
  // a read that failed counts, since nothing more can be learned.
  const answeredAt = Math.max(grants.dataUpdatedAt, grants.errorUpdatedAt);
  const stale = viaApp && failedAt !== null && !!seen && answeredAt < seen.at;
  const { refetch, isFetching } = grants;
  useEffect(() => {
    if (stale && !isFetching) void refetch();
  }, [stale, isFetching, refetch]);
  // The failed sync seen while permissions waited or settled, by when it
  // ran: it stays unshown afterwards, until a later sync reports.
  const [excused, setExcused] = useState<string | null>(null);
  if (
    (waitsForPermissions || settling) &&
    failedAt !== null &&
    excused !== failedAt
  )
    setExcused(failedAt);
  // GitHub refusing the App is never shown as an error here, whenever it
  // arrives: what the App lacks is the Finish setup notice's to say.
  if (viaApp && isAccessRefusal(source?.lastSyncError)) return false;
  return (
    failedAt !== null &&
    !stale &&
    !(viaApp && isFetching) &&
    !waitsForPermissions &&
    !settling &&
    excused !== failedAt
  );
}

/** How long after a grant GitHub may still refuse the App's calls. */
const GRANT_SETTLE_MS = 2 * 60_000;

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

/**
 * How far the repository's side of self-service is: `unread` until GitHub
 * answers, and while it cannot say; `unfinished` while the ruleset, the
 * App's Checks permission or the include still waits, which the Finish
 * setup notice lists; `complete` once the ruleset holds and the include is
 * merged.
 */
type SetupState = "unread" | "unfinished" | "complete";

function setupState(data: Protection | null): SetupState {
  if (!data) return "unread";
  const { branchRules, include } = data;
  if (
    branchRules.state === "unavailable" ||
    branchRules.state === "error" ||
    include.state === "unknown"
  )
    return "unread";
  return branchRules.state !== "active" ||
    branchRules.checkRule === "unposted" ||
    include.state !== "included"
    ? "unfinished"
    : "complete";
}

/**
 * The repository's state under the settings. Complete: the ruleset that
 * holds. Unfinished: only what the heading and Finish setup do not say, a
 * rule that holds pull requests and the include's pull request. Unread:
 * what could not be read.
 */
function RepositoryState({
  data,
  state,
  policyPath,
  branchUrl,
}: {
  data: Protection;
  state: SetupState;
  policyPath: string;
  /** The synced branch on the host, for the ruleset sentence. */
  branchUrl: string | null;
}) {
  const policyFile = policyPath.slice(policyPath.lastIndexOf("/") + 1);
  const rules = data.branchRules;
  const lines = [
    state === "complete" ||
    rules.checkRule === "unposted" ||
    rules.state === "unavailable" ||
    rules.state === "error"
      ? protectionSentence(rules, branchUrl, data.app)
      : null,
    includeSentence(data.include, policyFile),
  ].filter((line) => line != null);
  if (lines.length === 0) return null;
  return (
    <div className="space-y-1 text-sm leading-5 text-muted-foreground">
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: two fixed sentences
        <p key={index}>{line}</p>
      ))}
    </div>
  );
}

/**
 * One sentence on the include that makes the servers' files apply: the pull
 * request that adds the line, or that it could not be read. Included, the
 * folder sentence already says where the files go; missing, the heading and
 * Finish setup say so.
 */
function includeSentence(
  include: Protection["include"],
  policyFile: string,
): ReactNode {
  const entry = <code>{`${include.folder}/*.toml`}</code>;
  switch (include.state) {
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
          adds {entry} to {policyFile}.{" "}
          <ClickPath steps={appaGitHost(null).mergePath} />, then{" "}
          <span className="font-medium text-foreground">Sync now</span>.
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
      return null;
  }
}

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

/**
 * One sentence on the ruleset: that it holds, that it holds pull requests
 * until the App can post the check, or that it could not be read. The
 * heading and Finish setup cover every other state.
 */
function protectionSentence(
  rules: Protection["branchRules"],
  branchUrl: string | null,
  app: Protection["app"],
): ReactNode {
  if (rules.checkRule === "unposted")
    return (
      <>
        The Self-service branch protection {hostLink(rules.url, "ruleset")}{" "}
        holds pull requests until the{" "}
        {app ? <>{hostLink(app.url, app.name)} App</> : <span>GitHub App</span>}{" "}
        can post the check.
      </>
    );
  if (rules.state !== "active")
    return (
      <>
        The Self-service branch protection ruleset could not be checked
        {rules.detail && !isAccessRefusal(rules.detail) ? (
          <span>: {rules.detail}</span>
        ) : (
          <span>.</span>
        )}
      </>
    );
  return (
    <>
      {hostLink(rules.url, "Ruleset")} protects the policy on the{" "}
      {hostLink(branchUrl, "branch")}
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
      interval: source?.interval ?? DEFAULT_SYNC_INTERVAL,
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
        // Validations stay in the source's folder (traces by default), so
        // they are not asked here.
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
          <Label htmlFor="appa-interval">Sync schedule</Label>
          <SyncScheduleSelect
            id="appa-interval"
            value={form.watch("interval")}
            onValueChange={(value) =>
              form.setValue("interval", value, { shouldDirty: true })
            }
          />
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
