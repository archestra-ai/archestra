"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  CircleDashed,
  Download,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { SetupStepper } from "@/components/git/git-setup-chrome";
import { openGithubWindow } from "@/components/github-app-setup/github-app-window";
import { ManifestRow } from "@/components/github-app-setup/manifest-row";
import { GitHubConnectButton } from "@/components/github-connect-button";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field-description";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  useAppaGithubAppGrants,
  useAppaRepositoryProtection,
  useFreshAppaRepositoryProtection,
  useUpdateAppaGithubSync,
} from "@/lib/openappa-github-sync.query";
import { cn } from "@/lib/utils/tailwind";

type Step = "app" | "folder" | "enable";
type Grants = NonNullable<
  archestraApiTypes.GetAppaGithubAppGrantsResponses["200"]
>;
type Protection = NonNullable<
  archestraApiTypes.GetAppaRepositoryProtectionResponses["200"]
>;

const STEPS: { id: Step; label: string }[] = [
  { id: "app", label: "GitHub App" },
  { id: "folder", label: "Folder" },
  { id: "enable", label: "Turn on" },
];
const NEEDED = ["checks"] as const;
const DEFAULT_FOLDER = "mcp";
/**
 * A folder beside the policy file, nested as deep as wanted: segments of
 * letters, digits, `_`, `-` and inner dots, so no `*`, no `.` or `..`, and
 * not the batteries' own folder.
 */
const FOLDER =
  /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)*$/;
function isSelfServiceFolder(folder: string): boolean {
  return (
    FOLDER.test(folder) &&
    folder !== "batteries" &&
    !folder.startsWith("batteries/")
  );
}
const GITHUB_WINDOW = "archestra-github-app";

/**
 * Turning self-service on, in the Git sync setup's own steps: the GitHub
 * App's permission, the folder the servers' files go in, then the switch
 * itself with what it brings: the pull request that starts the folder and
 * includes it, and the branch ruleset the administrator imports. Already
 * on, the folder is fixed and the last step brings what is still missing.
 */
export function SelfServiceSetupDialog({
  open,
  onOpenChange,
  policyPath,
  directory,
  alreadyOn,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  policyPath: string;
  /** The saved folder, the dialog's starting value. */
  directory: string;
  /** Self-service is on: the folder cannot move, the last step repairs. */
  alreadyOn: boolean;
}) {
  const appName = useAppName();
  const update = useUpdateAppaGithubSync();
  const [step, setStep] = useState<Step>("app");
  const [folder, setFolder] = useState(directory || DEFAULT_FOLDER);
  const chosen = folder.trim().replace(/^\/+|\/+$/g, "");
  const folderValid = isSelfServiceFolder(chosen);
  const grants = useAppaGithubAppGrants(open);
  const granted = (name: Grants["permissions"][number]["name"]) =>
    grants.data?.permissions.find((entry) => entry.name === name)?.granted ===
    true;
  const ready = NEEDED.every(granted);
  const policyFile = policyPath.slice(policyPath.lastIndexOf("/") + 1);
  const header = headerFor(step, appName, grants.data?.name ?? null);
  return (
    <StandardDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && step === "enable") return;
        onOpenChange(next);
      }}
      title={header.title}
      description={header.description}
      size="medium"
      bodyClassName="space-y-5"
      footer={
        <>
          {step === "folder" ? (
            <Button
              type="button"
              variant="ghost"
              className="mr-auto"
              onClick={() => setStep("app")}
            >
              <ArrowLeft />
              <span>Back</span>
            </Button>
          ) : null}
          {step !== "enable" ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              <span>Cancel</span>
            </Button>
          ) : null}
          {step === "app" ? (
            <Button
              type="button"
              disabled={!ready}
              onClick={() => setStep(alreadyOn ? "enable" : "folder")}
            >
              <span>Continue</span>
            </Button>
          ) : null}
          {step === "folder" ? (
            <Button
              type="button"
              disabled={!folderValid}
              onClick={() => setStep("enable")}
            >
              <span>Turn on</span>
            </Button>
          ) : null}
          {step === "enable" ? (
            <EnableFooter onClose={() => onOpenChange(false)} />
          ) : null}
        </>
      }
    >
      <SetupStepper
        steps={STEPS.map((entry) => entry.label)}
        current={STEPS.findIndex((entry) => entry.id === step)}
        onSelect={(index) => {
          const target = STEPS[index];
          if (target && step !== "enable") setStep(target.id);
        }}
      />
      {step === "app" ? (
        <GithubAppPermissionsStep
          grants={grants.data ?? null}
          loading={grants.isPending}
          error={grants.isError ? grants.error.message : undefined}
          checking={grants.isFetching}
          ready={ready}
          onCheckAgain={() => void grants.refetch()}
        />
      ) : null}
      {step === "folder" ? (
        <div className="space-y-2">
          <Label htmlFor="self-service-folder">Self-service folder</Label>
          <FieldDescription>
            Each managed MCP server policy file goes here and included into the
            root policy. A pull request includes it to {policyFile} if not yet
            done.
          </FieldDescription>
          <Input
            id="self-service-folder"
            value={folder}
            placeholder={DEFAULT_FOLDER}
            autoComplete="off"
            data-1p-ignore
            spellCheck={false}
            aria-invalid={!folderValid}
            onChange={(event) => setFolder(event.target.value)}
          />
          {folderValid ? null : (
            <p className="text-xs text-destructive">
              Use a folder path such as <code>rules/servers</code>. Wildcards
              and <code>..</code> are not allowed.
            </p>
          )}
        </div>
      ) : null}
      {step === "enable" ? (
        <SelfServiceOutcomeStep
          run={() =>
            update.mutateAsync({
              action: "self_service",
              enabled: true,
              directory: alreadyOn ? directory : chosen,
            })
          }
          labels={{
            pending: "Turn MCP Guardrails Self-Service on",
            done: "MCP Guardrails Self-Service is on",
            failed: "Could not turn MCP Guardrails Self-Service on",
          }}
          directory={alreadyOn ? directory : chosen}
          policyFile={policyFile}
        />
      ) : null}
    </StandardDialog>
  );
}

function headerFor(step: Step, appName: string, githubApp: string | null) {
  if (step === "app")
    return {
      title: "MCP Guardrails Self-Service",
      description: `${appName} posts the policy check on each pull request. The ${githubApp ? `${githubApp} App` : "GitHub App"} needs one more permission for that.`,
    };
  if (step === "folder")
    return {
      title: "Choose the self-service folder",
      description: "Where each MCP server's own rules file lives.",
    };
  return {
    title: "Turning MCP Guardrails Self-Service on",
    description: "This takes a few seconds.",
  };
}

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
  title = (app) => (
    <>
      Grant the <code>Checks</code> permission to the {app} App
    </>
  ),
  hint = (
    <>
      Set it to <code>Read and write</code>: the App posts the check&apos;s
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
          {joined(
            grants.permissions
              .filter((entry) => entry.granted)
              .map((entry) => PERMISSION_LABELS[entry.name]),
            ", ",
          )}
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
            {joined(
              missing.map((name) => PERMISSION_LABELS[name]),
              " and ",
            )}
            . Check again once {needed.length > 1 ? "they are" : "it is"}{" "}
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

/** Permission names as code, separated as given. */
function joined(names: string[], separator: string): ReactNode {
  return names.map((name, index) => (
    <span key={name}>
      {index > 0 ? <span>{separator}</span> : null}
      <code>{name}</code>
    </span>
  ));
}

type Progress = "waiting" | "running" | "done" | "failed";

/**
 * A step that brings self-service about and what it brings, each with its
 * own progress: `run` (the switch, or a Git sync save that turns it on), the
 * pull request that starts the folder and includes it, and the branch
 * ruleset, which the administrator imports on GitHub and checks here. Runs
 * once when shown; a failed part offers a retry. The Git sync wizard shows
 * it too, so the dialog stays open on the pull request, and on the setup
 * pull request a connect may open, which carries the include itself.
 */
export function SelfServiceOutcomeStep({
  run: first,
  labels,
  directory,
  policyFile,
}: {
  /**
   * The first row's work; the rest reads the protection once it settles.
   * A result with `setupPull` names the pull request that carries the
   * current policy, so the first row waits on its merge.
   */
  run: () => Promise<unknown>;
  labels: {
    pending: string;
    done: string;
    /** The first row with a setup pull request, before its link. */
    proposed?: string;
    failed: string;
  };
  directory: string;
  policyFile: string;
}) {
  const update = useUpdateAppaGithubSync();
  const fresh = useFreshAppaRepositoryProtection();
  const [switched, setSwitched] = useState<Progress>("waiting");
  const [setupPull, setSetupPull] = useState<SetupPull | null>(null);
  const [rules, setRules] = useState<{
    /** `action`: the administrator imports or edits the ruleset on GitHub. */
    state: Progress | "action";
    detail?: Protection["branchRules"];
    /** The ruleset's name: the check's, as the protection reports it. */
    name?: string;
  }>({ state: "waiting" });
  const [include, setInclude] = useState<{
    state: Progress;
    detail?: Protection["include"];
    error?: string;
  }>({ state: "waiting" });
  const started = useRef(false);
  const mutate = update.mutateAsync;
  // Read from GitHub each time: what the run just set up, and later what
  // the administrator imported there.
  const refetch = fresh.mutateAsync;

  async function run() {
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
    // The switch is done whatever the reads after it bring: a read that
    // fails shows on its own row, with a check-again.
    setRules({ state: "running" });
    setInclude({ state: "running" });
    const read = await readProtection();
    if (read === undefined) return setInclude({ state: "waiting" });
    setRules(rulesStateOf(read));
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
      setInclude({ state: "done", detail: read.include });
      return;
    }
    try {
      await mutate({ action: "include_servers" });
      const again = await refetch();
      setInclude(
        again?.include.state === "included" ||
          again?.include.state === "pull_open"
          ? { state: "done", detail: again.include }
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

  const rulesLine = (() => {
    const detail = rules.detail;
    const check = rules.name ?? "policy";
    if (rules.state === "done")
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
    if (rules.state === "action")
      return (
        <BranchRuleActions
          rules={detail ?? { state: "error" }}
          checkName={check}
          checking={fresh.isPending}
          onCheckAgain={() => void checkRules()}
        />
      );
    if (rules.state === "running")
      return <span>Reading the branch rules…</span>;
    return <span>Import the branch ruleset on GitHub</span>;
  })();
  const includeLine = (() => {
    const detail = include.detail;
    if (include.state === "done" && detail?.state === "included")
      return (
        <span>
          {policyFile} already includes <code>{directory}/*.toml</code>.
        </span>
      );
    if (
      include.state === "done" &&
      detail?.pull &&
      detail.pull.number === setupPull?.number
    )
      return (
        <span>
          The setup pull request includes <code>{directory}/*.toml</code>.
        </span>
      );
    if (include.state === "done" && detail?.pull)
      return (
        <span>
          <a
            href={detail.pull.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground underline underline-offset-4"
          >
            Pull request #{detail.pull.number}
          </a>{" "}
          opened. Merge it and re-sync to apply the new settings.
        </span>
      );
    if (include.state === "failed")
      return (
        <span>
          Could not open the pull request
          {include.error ? `: ${include.error}` : "."}
        </span>
      );
    return (
      <span>
        Open the pull request that starts <code>{directory}/</code> and adds{" "}
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
        <ProgressRow state={switched}>
          {switched === "done" && setupPull ? (
            <span>
              {labels.proposed ?? labels.done}.{" "}
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
                ? labels.done
                : switched === "failed"
                  ? `${labels.failed}${include.error ? `: ${include.error}` : "."}`
                  : labels.pending}
            </span>
          )}
        </ProgressRow>
        <ProgressRow state={rules.state}>{rulesLine}</ProgressRow>
        <ProgressRow state={include.state}>{includeLine}</ProgressRow>
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
                  setInclude({
                    state:
                      result?.include.state === "missing" ? "failed" : "done",
                    detail: result?.include,
                  }),
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

/**
 * The branch ruleset that makes the policy check required, as a row of the
 * Self-service step, so the step stays in view once it is done. With
 * self-service saved on, GitHub's state now: in place with its link, or
 * what to import or change. Otherwise, where the import comes.
 */
export function BranchRulesetRow({
  saved,
  after,
}: {
  /** Self-service is on for the saved source, so its rules can be read. */
  saved: boolean;
  /** What brings the last step, "save" or "connect". */
  after: string;
}) {
  const protection = useAppaRepositoryProtection(saved);
  const fresh = useFreshAppaRepositoryProtection();
  const rules = saved ? protection.data?.branchRules : undefined;
  const checkName = protection.data?.checkName ?? "policy";
  const reading = saved && protection.isPending;
  const active = rules?.state === "active";
  return (
    <div className="flex items-start gap-3">
      <span
        className="mt-0.5 flex size-4 shrink-0 items-center justify-center"
        aria-hidden
      >
        {reading ? (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        ) : active ? (
          <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <CircleDashed className="size-4 text-muted-foreground" />
        )}
      </span>
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">Branch ruleset</p>
        <div className="text-xs text-muted-foreground">
          {!saved ? (
            <span>
              After you {after}, the last step offers the ruleset to import on
              GitHub. It makes the check required, so a pull request merges only
              once it passes.
            </span>
          ) : reading ? (
            <span>Reading the branch rules…</span>
          ) : !rules ? (
            <span>
              Could not read the branch rules. The last step checks them again
              after you {after}.
            </span>
          ) : active ? (
            <span>
              The{" "}
              {rules.url ? (
                <a
                  href={rules.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-foreground underline underline-offset-4"
                >
                  ruleset
                </a>
              ) : (
                <span>ruleset</span>
              )}{" "}
              requires the {checkName} check, so a pull request merges only once
              it passes.
            </span>
          ) : (
            <BranchRuleActions
              rules={rules}
              checkName={checkName}
              checking={fresh.isPending}
              onCheckAgain={() => void fresh.mutateAsync().catch(() => null)}
            />
          )}
        </div>
      </div>
    </div>
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

/** Close, once the last step has settled; the dialog cannot be dismissed before. */
function EnableFooter({ onClose }: { onClose: () => void }) {
  const update = useUpdateAppaGithubSync();
  return (
    <Button type="button" disabled={update.isPending} onClick={onClose}>
      <span>Done</span>
    </Button>
  );
}
