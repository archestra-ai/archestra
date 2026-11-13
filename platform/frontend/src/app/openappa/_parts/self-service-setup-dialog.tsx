"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  Check,
  Download,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { openGithubWindow } from "@/components/github-app-setup/github-app-window";
import { ManifestRow } from "@/components/github-app-setup/manifest-row";
import { GitHubConnectButton } from "@/components/github-connect-button";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import {
  useAppaGithubAppGrants,
  useAppaGithubSync,
  useAppaGithubSyncing,
  useAppaRepositoryProtection,
  useFreshAppaRepositoryProtection,
  useUpdateAppaGithubSync,
} from "@/lib/openappa-github-sync.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { appaGitHost } from "./appa-git-host";

type Grants = NonNullable<
  archestraApiTypes.GetAppaGithubAppGrantsResponses["200"]
>;
type Protection = NonNullable<
  archestraApiTypes.GetAppaRepositoryProtectionResponses["200"]
>;

const NEEDED = ["checks"] as const;
const GITHUB_WINDOW = "archestra-github-app";

const PERMISSION_LABELS = {
  contents: "Contents",
  pull_requests: "Pull requests",
  checks: "Checks",
  workflows: "Workflows",
} as const;

/**
 * The App's permissions: what it has, and where to grant the rest. Self-
 * service asks for Administration and Checks; a caller can ask for others,
 * such as Workflows for the validation workflow's updates.
 */
export function GithubAppPermissionsStep({
  grants,
  loading,
  error,
  checking,
  ready,
  onCheckAgain,
  needed = NEEDED,
  title = (app) => `Grant the Checks permission to the ${app} App`,
  hint = (
    <>
      Set it to <strong>Read and write</strong>: the App posts the check&apos;s
      verdict on each pull request. Making the check required is a branch
      ruleset you import yourself, so the App needs no Administration.
    </>
  ),
  readyText = "every permission self-service needs",
}: {
  grants: Grants | null;
  loading: boolean;
  error?: string;
  checking: boolean;
  ready: boolean;
  onCheckAgain: () => void;
  needed?: readonly Grants["permissions"][number]["name"][];
  title?: (app: string) => ReactNode;
  hint?: ReactNode;
  /** What the App has once every needed permission is granted. */
  readyText?: string;
}) {
  if (loading)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        <span>Reading the GitHub App's permissions…</span>
      </p>
    );
  if (!grants)
    return (
      <InlineNotice variant="warning">
        <InlineNoticeText className="flex-1">
          {error ??
            "This needs a GitHub App: connect the policy repository through one first."}
        </InlineNoticeText>
      </InlineNotice>
    );
  const missing = needed.filter(
    (name) =>
      grants.permissions.find((entry) => entry.name === name)?.granted !== true,
  );
  return (
    <div className="space-y-4">
      <ol className="overflow-hidden rounded-lg border bg-card">
        <ManifestRow
          index={1}
          title={title(grants.name)}
          hint={hint}
          inlineAction
          waiting={false}
          error={error}
          onCheckAgain={onCheckAgain}
          result={null}
          done={ready}
          action={
            <GitHubConnectButton
              label="Update App"
              onClick={() =>
                openGithubWindow(grants.settingsUrl, GITHUB_WINDOW)
              }
            />
          }
        />
        <ManifestRow
          index={2}
          title="Accept the new permission"
          hint={null}
          inlineAction
          waiting={false}
          onCheckAgain={onCheckAgain}
          result={null}
          done={ready}
          action={
            grants.installationUrl ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  openGithubWindow(grants.installationUrl ?? "", GITHUB_WINDOW)
                }
              >
                <span>Approve the request</span>
              </Button>
            ) : null
          }
        />
      </ol>
      {grants.permissions.some((entry) => entry.granted) ? (
        <p className="text-xs text-muted-foreground">
          Granted:{" "}
          {grants.permissions
            .filter((entry) => entry.granted)
            .map((entry) => PERMISSION_LABELS[entry.name])
            .join(", ")}
          .
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
        {ready ? (
          <span>
            The {grants.name} App has {readyText}.
          </span>
        ) : (
          <span>
            Missing:{" "}
            {missing.map((name) => PERMISSION_LABELS[name]).join(" and ")}.
            Check again once {needed.length > 1 ? "they are" : "it is"}{" "}
            accepted.
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          aria-label="Check again"
          disabled={checking}
          onClick={onCheckAgain}
        >
          <RefreshCw
            className={cn("size-3.5", checking && "animate-spin")}
            aria-hidden
          />
        </Button>
      </div>
    </div>
  );
}

type Progress = "waiting" | "running" | "done" | "failed";

/**
 * The setup's Finish step, the last step of every Git sync wizard: what is in
 * place and what still waits, each with its own progress. With `run` (a
 * save, a connect, the self-service switch), that work comes first, once,
 * when the step is shown; the rest reads what it brought about, and with
 * self-service on, the include it needs is opened. Without `run`, it reads
 * what is in place now, so the step can be opened again at any time.
 */
export function SetupChecklist({
  run: first,
  labels,
  selfService: selfServiceGiven,
  directory: directoryGiven,
  policyFile: policyFileGiven,
}: {
  /**
   * The first row's work; the rest reads the protection once it settles.
   * A result with `setupPull` names the pull request that carries the
   * current policy, so the first row waits on its merge.
   */
  run?: () => Promise<unknown>;
  labels?: {
    pending: string;
    done: string;
    /** The first row with a setup pull request, before its link. */
    proposed?: string;
    failed: string;
  };
  /** Whether the self-service rows show; the saved setting unless given. */
  selfService?: boolean;
  directory?: string;
  policyFile?: string;
}) {
  const words: NonNullable<typeof labels> = labels ?? {
    pending: "",
    done: "",
    failed: "",
  };
  const status = useAppaGithubSync().data;
  const selfService = selfServiceGiven ?? status?.selfService?.enabled === true;
  const directory = directoryGiven ?? status?.selfService?.directory ?? "mcp";
  const policyFile =
    policyFileGiven ?? status?.source?.path?.split("/").pop() ?? "appa.toml";
  const update = useUpdateAppaGithubSync({ quiet: true });
  const fresh = useFreshAppaRepositoryProtection();
  const [switched, setSwitched] = useState<Progress>(
    first ? "waiting" : "done",
  );
  const [setupPull, setSetupPull] = useState<SetupPull | null>(null);
  const [rules, setRules] = useState<{
    /** `action`: the administrator imports or edits the ruleset on GitHub. */
    state: Progress | "action";
    detail?: Protection["branchRules"];
    /** The ruleset's name: the check's, as the protection reports it. */
    name?: string;
  }>({ state: "waiting" });
  const [include, setInclude] = useState<{
    /** `action`: its pull request waits for a merge on the host. */
    state: Progress | "action";
    detail?: Protection["include"];
    error?: string;
  }>({ state: "waiting" });
  const started = useRef(false);
  const mutate = update.mutateAsync;
  // Read from GitHub each time: what the run just set up, and later what
  // the administrator imported there.
  const refetch = fresh.mutateAsync;

  async function run() {
    if (first)
      try {
        setSwitched("running");
        const outcome = await first();
        setSetupPull(setupPullOf(outcome));
        setSwitched("done");
      } catch (error) {
        setSwitched("failed");
        setRules({ state: "waiting" });
        setInclude({
          state: "waiting",
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    if (!selfService) return;
    // The switch is done whatever the reads after it bring: a read that
    // fails shows on its own row, with a check-again.
    setRules({ state: "running" });
    setInclude({ state: "running" });
    const read = await readProtection();
    if (read === undefined) return setInclude({ state: "waiting" });
    setRules(rulesStateOf(read));
    // A missing include opens as a pull request here too: the wizard opens
    // what setup needs rather than offering a button for it.
    await settleInclude(read);
  }
  /** The protection from GitHub, or undefined once a failed read is shown. */
  async function readProtection(): Promise<Protection | null | undefined> {
    try {
      return await refetch();
    } catch (error) {
      setRules({
        state: "action",
        detail: {
          state: "error",
          detail: error instanceof Error ? error.message : String(error),
        },
      });
      return undefined;
    }
  }
  /** The include row from a read: in place, on its way, or opened now. */
  async function settleInclude(read: Protection | null) {
    if (
      read?.include.state === "included" ||
      read?.include.state === "pull_open"
    ) {
      setInclude(includeProgress(read.include));
      return;
    }
    try {
      await mutate({ action: "include_servers" });
      const again = await refetch();
      setInclude(
        again?.include.state === "included" ||
          again?.include.state === "pull_open"
          ? includeProgress(again.include)
          : { state: "failed", detail: again?.include },
      );
    } catch (error) {
      setInclude({
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // The administrator imported or edited the ruleset: read the branch again.
  async function checkRules() {
    setRules((current) => ({ ...current, state: "running" }));
    const read = await readProtection();
    if (read === undefined) return;
    setRules(rulesStateOf(read));
    // An include left waiting by a failed read settles with this one.
    if (include.state === "waiting") await settleInclude(read);
  }
  // Runs once, when the step is shown.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one run per showing
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, []);

  // What the repository holds now, read again after each pull: a merge or an
  // import on GitHub shows here without a check-again. The step's own reads
  // and runs show while they go.
  const live = useAppaRepositoryProtection(selfService).data;
  const rulesView =
    rules.state === "running" || !live ? rules : rulesStateOf(live);
  const includeView =
    include.state === "running" || include.state === "failed" || !live
      ? include
      : live.include.state === "included" || live.include.state === "pull_open"
        ? includeProgress(live.include)
        : include;
  const git = appaGitHost(status);
  const rulesLine = (() => {
    const detail = rulesView.detail;
    const check = rulesView.name ?? "policy";
    if (rulesView.state === "done")
      return (
        <span>
          {detail?.url ? (
            <a
              href={detail.url}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-foreground underline underline-offset-4"
            >
              Ruleset
            </a>
          ) : (
            <span>A ruleset</span>
          )}{" "}
          requires the {check} check on the branch.
        </span>
      );
    if (rulesView.state === "action")
      return (
        <BranchRuleActions
          rules={detail ?? { state: "error" }}
          checkName={check}
          checking={fresh.isPending}
          onCheckAgain={() => void checkRules()}
        />
      );
    if (rulesView.state === "running")
      return <span>Reading the branch rules…</span>;
    return <span>Import the branch ruleset on GitHub</span>;
  })();
  const includeLine = (() => {
    const detail = includeView.detail;
    if (includeView.state === "done")
      return (
        <span>
          {policyFile} includes <code>{directory}/*.toml</code>.
        </span>
      );
    // Merged is the only done: a pull request that carries the include waits
    // for its merge, the setup pull request among them.
    if (includeView.state === "action" && detail?.pull)
      return (
        <span>
          <a
            href={detail.pull.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground underline underline-offset-4"
          >
            {`${git.changeRequestShort} #${detail.pull.number}`}
          </a>{" "}
          {detail.pull.number ===
          (setupPull?.number ?? status?.source?.setupPullRequestNumber)
            ? "carries the initial policy with"
            : "adds"}{" "}
          <code>{directory}/*.toml</code> to {policyFile}: waiting for merge.
        </span>
      );
    if (includeView.state === "failed")
      return (
        <span>
          Could not open the pull request
          {include.error ? `: ${include.error}` : "."}
        </span>
      );
    return (
      <span>
        Opening the pull request that starts <code>{directory}/</code> and adds{" "}
        <code>{directory}/*.toml</code> to {policyFile}
      </span>
    );
  })();
  return (
    <div className="space-y-3">
      <ul
        className="space-y-3 rounded-lg border bg-card p-4"
        aria-live="polite"
      >
        {first ? (
          <ProgressRow state={switched}>
            {switched === "done" && setupPull ? (
              <span>
                {words.proposed ?? words.done}.{" "}
                <a
                  href={setupPull.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-foreground underline underline-offset-4"
                >
                  Pull request #{setupPull.number}
                </a>{" "}
                carries the current policy: merge it, and the next sync finishes
                setup.
              </span>
            ) : (
              <span>
                {switched === "done"
                  ? words.done
                  : switched === "failed"
                    ? `${words.failed}${include.error ? `: ${include.error}` : "."}`
                    : words.pending}
              </span>
            )}
          </ProgressRow>
        ) : null}
        {switched === "done" ? <SourceRows /> : null}
        {selfService ? (
          <>
            <ProgressRow state={rulesView.state}>{rulesLine}</ProgressRow>
            <ProgressRow state={includeView.state}>{includeLine}</ProgressRow>
          </>
        ) : null}
      </ul>
      {switched === "failed" || include.state === "failed" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={update.isPending}
          onClick={() => {
            if (switched === "failed") void run();
            else {
              setInclude({ state: "running" });
              mutate({ action: "include_servers" })
                .then(() => refetch())
                .then((result) =>
                  setInclude(
                    result?.include.state === "included" ||
                      result?.include.state === "pull_open"
                      ? includeProgress(result.include)
                      : { state: "failed", detail: result?.include },
                  ),
                )
                .catch((error: unknown) =>
                  setInclude({
                    state: "failed",
                    error:
                      error instanceof Error ? error.message : String(error),
                  }),
                );
            }
          }}
        >
          <span>Try again</span>
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The rows every source has, as the last sync left them: the repository and
 * the setup pull request it may wait on, the policy check on its pull
 * requests, and the files beside the policy. A setup pull request that
 * waits is checked again on coming back to this tab.
 */
function SourceRows() {
  const query = useAppaGithubSync();
  const status = query.data;
  const source = status?.source;
  const files = status?.templateFiles;
  const app = !!source?.githubAppConfigId;
  const lacksGrant =
    status?.check?.state === "refused" ||
    files?.state === "needs_permission" ||
    (files?.withheld?.length ?? 0) > 0;
  const grants = useAppaGithubAppGrants(app && lacksGrant);
  const update = useUpdateAppaGithubSync({ quiet: true });
  const syncing = useAppaGithubSyncing();
  const protection = useAppaRepositoryProtection(
    status?.selfService?.enabled === true,
  );
  // Anything that waits for a merge on the host is checked again on coming
  // back to this tab: the setup pull request, the files update, the include.
  const waiting = !!source?.setupPullRequestNumber;
  const mergeAwaited =
    waiting || !!files?.pull || protection.data?.include.state === "pull_open";
  const { mutate } = update;
  useEffect(() => {
    if (!mergeAwaited) return;
    const check = () => {
      if (document.visibilityState === "visible" && !syncing)
        mutate({ action: "sync" });
    };
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [mergeAwaited, syncing, mutate]);
  if (!status || !source?.repo) return null;
  const git = appaGitHost(status);
  const urls = git.urls(source.repo);
  const link = (href: string, text: string) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-foreground underline underline-offset-4"
    >
      {text}
    </a>
  );
  const grantActions = grants.data ? (
    <span className="mt-2 flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() =>
          openGithubWindow(grants.data?.settingsUrl ?? "", GITHUB_WINDOW)
        }
      >
        <span>Update App</span>
        <ExternalLink aria-hidden />
      </Button>
      {grants.data.installationUrl ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() =>
            openGithubWindow(grants.data?.installationUrl ?? "", GITHUB_WINDOW)
          }
        >
          <span>Approve the request</span>
          <ExternalLink aria-hidden />
        </Button>
      ) : null}
    </span>
  ) : null;
  const checked = source.lastSyncedAt
    ? ` · checked ${formatRelativeTimeFromNow(source.lastSyncedAt).toLowerCase()}`
    : "";
  return (
    <>
      <ProgressRow
        state={source.lastSyncError ? "failed" : waiting ? "action" : "done"}
      >
        {source.lastSyncError ? (
          <span>Could not sync the policy: {source.lastSyncError}</span>
        ) : waiting && source.setupPullRequestNumber ? (
          <span>
            {link(
              urls.changeRequest(source.setupPullRequestNumber),
              `${git.changeRequestShort} #${source.setupPullRequestNumber}`,
            )}{" "}
            carries the initial policy: waiting for merge{checked}.
          </span>
        ) : (
          <span>
            The policy syncs from {link(urls.repo, source.repo)}
            {checked}.
          </span>
        )}
      </ProgressRow>
      {app && status.check && status.check.state !== "none" ? (
        <ProgressRow
          state={status.check.state === "posted" ? "done" : "action"}
        >
          {status.check.state === "posted" ? (
            <span>
              The {status.check.name} check goes on every {git.changeRequest}.
            </span>
          ) : (
            <span className="block">
              <span className="block">
                The {status.check.name} check is not posted: the GitHub App
                needs the Checks permission.
              </span>
              {grantActions}
            </span>
          )}
        </ProgressRow>
      ) : null}
      {files && files.state !== "not_applicable" ? (
        <ProgressRow
          state={
            files.state === "current"
              ? "done"
              : files.state === "unavailable"
                ? "failed"
                : "action"
          }
        >
          {files.state === "current" ? (
            <span>The files beside the policy are current.</span>
          ) : files.state === "unavailable" ? (
            <span>
              Could not compare the files beside the policy
              {files.detail ? `: ${files.detail}` : "."}
            </span>
          ) : (
            <span className="block">
              <span className="block">
                {files.pull ? (
                  <span>
                    {link(
                      files.pull.url,
                      `${git.changeRequestShort} #${files.pull.number}`,
                    )}{" "}
                    updates the files beside the policy: waiting for merge.
                  </span>
                ) : (
                  <span>
                    The validation workflow update waits for the Workflows
                    permission.
                  </span>
                )}
                {files.pull && (files.withheld?.length ?? 0) > 0 ? (
                  <span>
                    {" "}
                    The validation workflow follows once the App may write
                    workflows.
                  </span>
                ) : null}
              </span>
              {(files.withheld?.length ?? 0) > 0 ||
              files.state === "needs_permission"
                ? grantActions
                : null}
            </span>
          )}
        </ProgressRow>
      ) : null}
    </>
  );
}

type SetupPull = { number: number; url: string };

/** The setup pull request a run's result names, if any. */
function setupPullOf(outcome: unknown): SetupPull | null {
  if (typeof outcome !== "object" || outcome === null) return null;
  const pull = (outcome as { setupPull?: unknown }).setupPull;
  return typeof pull === "object" &&
    pull !== null &&
    typeof (pull as SetupPull).number === "number" &&
    typeof (pull as SetupPull).url === "string"
    ? (pull as SetupPull)
    : null;
}

/**
 * The branch ruleset's state from a protection read: in place, or over to
 * the administrator, who imports or edits it on GitHub.
 */
function rulesStateOf(read: Protection | null): {
  state: Progress | "action";
  detail?: Protection["branchRules"];
  name?: string;
} {
  return read?.branchRules.state === "active"
    ? { state: "done", detail: read.branchRules, name: read.checkName }
    : { state: "action", detail: read?.branchRules, name: read?.checkName };
}

/** The include row from a read: done once merged, else waiting for its merge. */
function includeProgress(include: Protection["include"]): {
  state: Progress | "action";
  detail: Protection["include"];
} {
  return {
    state: include.state === "included" ? "done" : "action",
    detail: include,
  };
}

/**
 * What makes the check required to merge: a branch ruleset. Archestra reads
 * the branch's rules and writes none, so the administrator downloads the
 * ruleset, imports it on the repository's Rulesets page and checks again.
 */
export function BranchRuleActions({
  rules,
  checkName,
  checking,
  onCheckAgain,
}: {
  rules: Protection["branchRules"];
  checkName: string;
  checking: boolean;
  onCheckAgain: () => void;
}) {
  const sentence = (() => {
    switch (rules.state) {
      case "missing":
        return (
          <>
            Import the branch ruleset on GitHub, so a pull request merges only
            once the {checkName} check passes: <strong>New ruleset</strong> →{" "}
            <strong>Import a ruleset</strong>, then <strong>Create</strong>.
          </>
        );
      case "incomplete":
        return <>{rules.detail ?? "The branch ruleset needs a change."}</>;
      case "needs_permission":
        // A rule that requires a check nobody can post would hold every
        // pull request: the import waits for the permission.
        return (
          <>
            {rules.detail ?? "The GitHub App needs the Checks permission."}{" "}
            Grant it with Finish setup on the Git sync card, then import the
            ruleset.
          </>
        );
      default:
        return (
          <>
            Could not read the branch rules
            {rules.detail ? `: ${rules.detail}` : "."}
          </>
        );
    }
  })();
  const { settingsUrl } = rules;
  const ruleset =
    rules.state === "needs_permission" ? undefined : rules.ruleset;
  return (
    <span className="block space-y-2">
      <span className="block">{sentence}</span>
      <span className="flex flex-wrap items-center gap-2">
        {ruleset ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => downloadRuleset(ruleset, checkName)}
          >
            <Download aria-hidden />
            <span>Download ruleset</span>
          </Button>
        ) : null}
        {settingsUrl && ruleset ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => openGithubWindow(settingsUrl, GITHUB_WINDOW)}
          >
            <span>Open rulesets</span>
            <ExternalLink aria-hidden />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          aria-label="Check the branch rules again"
          disabled={checking}
          onClick={onCheckAgain}
        >
          <RefreshCw
            className={cn("size-3.5", checking && "animate-spin")}
            aria-hidden
          />
        </Button>
      </span>
    </span>
  );
}

/** The ruleset as a file, named after the check, for GitHub's import. */
function downloadRuleset(ruleset: object, checkName: string) {
  const name = `${checkName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}.ruleset.json`;
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(ruleset, null, 2)}\n`], {
      type: "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function ProgressRow({
  state,
  children,
}: {
  state: Progress | "action";
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 text-sm">
      {state === "running" ? (
        <LoaderCircle
          className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground"
          aria-label="In progress"
        />
      ) : state === "done" ? (
        <Check
          className="mt-0.5 size-4 shrink-0 text-emerald-600"
          aria-label="Done"
        />
      ) : state === "failed" || state === "action" ? (
        <span className="mt-1 flex size-4 shrink-0 items-center justify-center">
          <span className="size-2 rounded-full bg-amber-500" />
          <span className="sr-only">
            {state === "failed" ? "Failed" : "Action needed"}
          </span>
        </span>
      ) : (
        <span className="mt-1 flex size-4 shrink-0 items-center justify-center">
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
        </span>
      )}
      <span className={cn(state === "waiting" && "text-muted-foreground")}>
        {children}
      </span>
    </li>
  );
}
