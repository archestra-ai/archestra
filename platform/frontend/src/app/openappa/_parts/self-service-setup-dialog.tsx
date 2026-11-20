"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  ArrowLeft,
  Check,
  Download,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SetupStepper } from "@/components/git/git-setup-chrome";
import { ClickPath } from "@/components/github-app-setup/click-path";
import { openGithubWindow } from "@/components/github-app-setup/github-app-window";
import { ManifestRow } from "@/components/github-app-setup/manifest-row";
import { GitHubConnectButton } from "@/components/github-connect-button";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldDescription } from "@/components/ui/field-description";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppName } from "@/lib/hooks/use-app-name";
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
import { appaGitHost, isAccessRefusal, shownFailure } from "./appa-git-host";

type Step = "app" | "folder" | "enable";
type Grants = NonNullable<
  archestraApiTypes.GetAppaGithubAppGrantsResponses["200"]
>;
type Protection = NonNullable<
  archestraApiTypes.GetAppaRepositoryProtectionResponses["200"]
>;

const STEPS: { id: Step; label: string }[] = [
  { id: "app", label: "GitHub App" },
  { id: "folder", label: "Self-service" },
  { id: "enable", label: "Finish" },
];
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
  const update = useUpdateAppaGithubSync({ quiet: true });
  const [step, setStep] = useState<Step>("app");
  const [folder, setFolder] = useState(directory || DEFAULT_FOLDER);
  const chosen = folder.trim().replace(/^\/+|\/+$/g, "");
  const folderValid = isSelfServiceFolder(chosen);
  // Whether the App merges each server's rules pull request once its check
  // passes: on unless unticked here, as in the Git sync setup. The
  // environment variable, while set, decides instead.
  const [chosenAutoMerge, setAutoMerge] = useState(true);
  const autoMergeEnvironment =
    useAppaGithubSync().data?.selfService?.autoMerge?.environment;
  const autoMerge = autoMergeEnvironment
    ? autoMergeEnvironment.value === "enabled"
    : chosenAutoMerge;
  const grants = useAppaGithubAppGrants(open);
  const ready =
    !!grants.data && missingAppPermissions(grants.data).length === 0;
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
          checkedAt={grants.dataUpdatedAt || undefined}
        />
      ) : null}
      {step === "folder" ? (
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="self-service-folder">Self-service folder</Label>
            <FieldDescription>
              Each MCP server policy file goes here.
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
          <div className="flex items-start gap-3">
            <Checkbox
              id="self-service-auto-merge"
              className="mt-0.5"
              checked={autoMerge}
              disabled={!!autoMergeEnvironment}
              onCheckedChange={(checked) => setAutoMerge(checked === true)}
            />
            <div className="space-y-1">
              <Label htmlFor="self-service-auto-merge">
                Auto-merge pull requests
              </Label>
              <FieldDescription>
                MCP owners can manage their guardrails without GitHub access.
              </FieldDescription>
              {autoMergeEnvironment ? (
                <FieldDescription>
                  Set with{" "}
                  <code className="font-mono">
                    {autoMergeEnvironment.variable}={autoMergeEnvironment.value}
                  </code>
                  . Unset the environment variable to choose here.
                </FieldDescription>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      {step === "enable" ? (
        <SetupChecklist
          selfService
          run={async () => {
            const turnedOn = await update.mutateAsync({
              action: "self_service",
              enabled: true,
              directory: alreadyOn ? directory : chosen,
            });
            // Auto-merge takes self-service in force, so it follows the
            // switch. Already on, the saved choice stands: Edit changes it.
            if (alreadyOn || autoMergeEnvironment || !chosenAutoMerge)
              return turnedOn;
            return update.mutateAsync({
              action: "self_service_auto_merge",
              enabled: true,
            });
          }}
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
      description: `${appName} reads the policy, opens pull requests and posts the policy check through the ${githubApp ? `${githubApp} App` : "GitHub App"}. It needs every permission below.`,
    };
  if (step === "folder")
    return {
      title: "MCP Guardrails Self-Service",
      description: "Choose the folder and how pull requests merge.",
    };
  return {
    title: "Finish setup",
    description: "What is in place, and what still waits for you.",
  };
}

export const APP_PERMISSION_LABELS = {
  contents: "Contents",
  pull_requests: "Pull requests",
  checks: "Checks",
  workflows: "Workflows",
} as const;
export type AppPermission = keyof typeof APP_PERMISSION_LABELS;

/**
 * The permissions the App lacks, as GitHub reports them now. Every wizard
 * step and the Git sync card read this one list, so none calls an App fine
 * that another finds lacking.
 */
export function missingAppPermissions(
  grants: Grants | null | undefined,
): AppPermission[] {
  return (grants?.permissions ?? [])
    .filter((permission) => !permission.granted)
    .map((permission) => permission.name);
}

/**
 * Of the missing permissions, those the App's settings do not ask for yet.
 * The rest are saved there and wait for the installation to accept them.
 * Where GitHub's answer does not say, every missing one counts.
 */
export function unaskedAppPermissions(
  grants: Grants | null | undefined,
): AppPermission[] {
  return (grants?.permissions ?? [])
    .filter(
      (permission) => !permission.granted && permission.requested !== true,
    )
    .map((permission) => permission.name);
}

/** "Checks", "Contents and Checks", "Contents, Pull requests and Checks". */
export function appPermissionList(names: readonly AppPermission[]): string {
  const labels = names.map((name) => APP_PERMISSION_LABELS[name]);
  return labels.length > 1
    ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
    : (labels[0] ?? "");
}

/** Where a permission is granted on the App's settings page on GitHub. */
function permissionPath(name: AppPermission) {
  return [
    "Repository permissions",
    APP_PERMISSION_LABELS[name],
    "Read and write",
  ];
}
/** Where the App's installation accepts permissions its settings now ask for. */
const ACCEPT_PATH = ["Review request", "Accept new permissions"];

/**
 * The App's permissions: whether GitHub grants every one Git sync asks for,
 * and where to grant the rest.
 */
export function GithubAppPermissionsStep({
  grants,
  loading,
  error,
  checking,
  ready,
  onCheckAgain,
  checkedAt,
}: {
  grants: Grants | null;
  loading: boolean;
  error?: string;
  checking: boolean;
  ready: boolean;
  onCheckAgain: () => void;
  /** When GitHub last answered, so a check that changes nothing still shows. */
  checkedAt?: number;
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
  const missing = missingAppPermissions(grants);
  // Saved in the App's settings, not yet accepted by its installation:
  // the first step is done and the second is the one that waits.
  const unasked = unaskedAppPermissions(grants);
  const asked = missing.length > 0 && unasked.length === 0;
  // One string with the time GitHub last answered, so a check that changes
  // nothing still shows that it ran.
  const waiting = `${asked ? "Waiting for approval" : "Missing"}: ${appPermissionList(missing)}${
    checkedAt
      ? ` · checked ${formatRelativeTimeFromNow(new Date(checkedAt).toISOString()).toLowerCase()}`
      : "."
  }`;
  return (
    // One box: the two steps, then what GitHub reports and the button that
    // reads it again, beside the rows it updates.
    <div className="overflow-hidden rounded-lg border bg-card">
      <ol>
        <ManifestRow
          index={1}
          title={`Add permissions to the ${grants.name} App`}
          hint={
            <>
              {unasked.map((name) => (
                <ClickPath
                  key={name}
                  className="block"
                  steps={permissionPath(name)}
                />
              ))}
              <ClickPath className="block" steps={["Save changes"]} />
            </>
          }
          inlineAction
          waiting={false}
          error={error}
          onCheckAgain={onCheckAgain}
          result={null}
          done={ready || asked}
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
          title="Accept the updated permissions"
          hint={<ClickPath steps={ACCEPT_PATH} />}
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
      <div className="flex items-center justify-between gap-3 border-t bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
        {ready ? (
          <span>The {grants.name} App has the required permissions.</span>
        ) : (
          <span>{waiting}</span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={checking}
          onClick={onCheckAgain}
        >
          <RefreshCw
            className={cn("size-3.5", checking && "animate-spin")}
            aria-hidden
          />
          <span>Check again</span>
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
                carries the current policy. <ClickPath steps={git.mergePath} />,
                and the next sync finishes setup.
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
  // What GitHub grants the App now: the one reading every row goes by.
  const grants = useAppaGithubAppGrants(app);
  const missing = missingAppPermissions(grants.data);
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
  // Each button opens the page on GitHub; beside it, what to click there.
  const unasked = unaskedAppPermissions(grants.data);
  const grantActions = grants.data ? (
    <span className="mt-2 block space-y-2">
      {unasked.length > 0 ? (
        <span className="flex flex-wrap items-start gap-x-3 gap-y-1">
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
          <span className="space-y-0.5 text-xs">
            {unasked.map((name) => (
              <ClickPath
                key={name}
                className="block"
                steps={permissionPath(name)}
              />
            ))}
            <ClickPath className="block" steps={["Save changes"]} />
          </span>
        </span>
      ) : null}
      {grants.data.installationUrl ? (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() =>
              openGithubWindow(
                grants.data?.installationUrl ?? "",
                GITHUB_WINDOW,
              )
            }
          >
            <span>Approve the request</span>
            <ExternalLink aria-hidden />
          </Button>
          <ClickPath className="text-xs" steps={ACCEPT_PATH} />
        </span>
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
          // GitHub refusing the App is said by the permissions row below.
          <span>
            Could not sync the policy
            {shownFailure(source, source.lastSyncError) ? (
              <span>: {source.lastSyncError}</span>
            ) : (
              <span>.</span>
            )}
          </span>
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
      {grants.data ? (
        <ProgressRow state={missing.length > 0 ? "action" : "done"}>
          {missing.length > 0 ? (
            <span className="block">
              <span className="block">
                {unasked.length > 0 ? (
                  <span>
                    The {grants.data.name} App needs the{" "}
                    {appPermissionList(missing)}{" "}
                    {missing.length > 1 ? "permissions" : "permission"}.
                  </span>
                ) : (
                  <span>
                    The {grants.data.name} App's installation has still to
                    accept the {appPermissionList(missing)}{" "}
                    {missing.length > 1 ? "permissions" : "permission"}.
                  </span>
                )}
              </span>
              {grantActions}
            </span>
          ) : (
            <span>
              The {grants.data.name} App has the permissions it needs.
            </span>
          )}
        </ProgressRow>
      ) : null}
      {app && status.check && status.check.state !== "none" ? (
        <ProgressRow
          state={status.check.state === "posted" ? "done" : "action"}
        >
          {status.check.state === "posted" ? (
            <span>
              The {status.check.name} check goes on every {git.changeRequest}.
            </span>
          ) : (
            // The permissions row above says what the App lacks, if anything.
            <span>
              The {status.check.name} check is not posted
              {missing.length > 0 ? (
                <span>: it waits for the App's permissions.</span>
              ) : shownFailure(source, status.check.detail) ? (
                <span>: {status.check.detail}.</span>
              ) : (
                <span>.</span>
              )}
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
              {shownFailure(source, files.detail) ? `: ${files.detail}` : "."}
            </span>
          ) : (
            <span>
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
            <span className="block">
              Import the branch ruleset, so a pull request merges only once the{" "}
              {checkName} check passes.
            </span>
            <ClickPath className="block" steps={IMPORT_PATH} />
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
            {rules.detail && !isAccessRefusal(rules.detail)
              ? `: ${rules.detail}`
              : "."}
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
          size="xs"
          disabled={checking}
          onClick={onCheckAgain}
        >
          <RefreshCw className={cn(checking && "animate-spin")} aria-hidden />
          <span>Check again</span>
        </Button>
      </span>
    </span>
  );
}

/** Importing the downloaded ruleset, from the repository's Rulesets page. */
const IMPORT_PATH = [
  "New ruleset",
  "Import a ruleset",
  { key: "file", label: "the downloaded file" },
  "Create",
];

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
  const update = useUpdateAppaGithubSync({ quiet: true });
  const syncing = useAppaGithubSyncing();
  return (
    <Button
      type="button"
      disabled={update.isPending}
      onClick={() => {
        // Done syncs at once, so the card shows what the checklist brought.
        if (!syncing) update.mutate({ action: "sync" });
        onClose();
      }}
    >
      <span>Done</span>
    </Button>
  );
}
