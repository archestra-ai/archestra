"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitPullRequestArrow,
  ListChecks,
  LoaderCircle,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { SetupStepper } from "@/components/git/git-setup-chrome";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useHasPermissions } from "@/lib/auth/auth.query";
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
import {
  GithubAppPermissionsStep,
  SetupChecklist,
} from "./self-service-setup-dialog";

type Status = archestraApiTypes.GetAppaGithubSyncResponses["200"];
type Protection = NonNullable<
  archestraApiTypes.GetAppaRepositoryProtectionResponses["200"]
>;
type Permission = "workflows" | "checks";

/** A pull request setup waits on, by what it carries. */
export type SetupPull = {
  kind: "setup" | "files" | "include";
  number: number;
  url: string;
};

/**
 * What the Git sync setup still waits on, read off the card's status: the
 * GitHub App's permissions, the self-service protection, and the pull
 * requests to merge. Null when nothing does.
 */
export type FinishSetupPieces = {
  permissions: Permission[];
  /** Self-service is on and its ruleset or include is not in place yet. */
  selfService: { directory: string; policyFile: string } | null;
  pulls: SetupPull[];
  /**
   * Self-service is on and nothing includes its folder yet: the wizard opens
   * that pull request itself and lists it with the others.
   */
  includeMissing: boolean;
};

export function finishSetupPieces(
  status: Status,
  protection: Protection | null | undefined,
): FinishSetupPieces | null {
  const source = status.source;
  if (!source?.repo || !source.path) return null;
  const git = appaGitHost(status);
  const urls = git.urls(source.repo);
  const files = status.templateFiles;
  const permissions: Permission[] = [];
  // An App grants Workflows; a source read with an access token says what
  // its token lacks on the card instead.
  if (
    source.githubAppConfigId &&
    (files?.state === "needs_permission" || files?.withheld?.length)
  )
    permissions.push("workflows");
  if (
    status.check?.state === "refused" ||
    protection?.branchRules.state === "needs_permission" ||
    protection?.branchRules.checkRule === "unposted"
  )
    permissions.push("checks");
  const pulls: SetupPull[] = [];
  if (source.setupPullRequestNumber)
    pulls.push({
      kind: "setup",
      number: source.setupPullRequestNumber,
      url: urls.changeRequest(source.setupPullRequestNumber),
    });
  // Kept through a failed check too: it still waits for its merge.
  if (files?.pull) pulls.push({ kind: "files", ...files.pull });
  if (
    protection?.include.state === "pull_open" &&
    protection.include.pull &&
    protection.include.pull.number !== source.setupPullRequestNumber
  )
    pulls.push({ kind: "include", ...protection.include.pull });
  const includeMissing =
    status.selfService?.enabled === true &&
    protection?.include.state === "missing";
  const selfService =
    status.selfService?.enabled &&
    protection &&
    (protection.branchRules.state !== "active" || includeMissing)
      ? {
          directory: status.selfService?.directory ?? "mcp",
          policyFile: source.path.slice(source.path.lastIndexOf("/") + 1),
        }
      : null;
  if (permissions.length === 0 && !selfService && pulls.length === 0)
    return null;
  return { permissions, selfService, pulls, includeMissing };
}

/**
 * What the Git sync setup still waits on, the same everywhere a page asks:
 * the Git sync settings and every Guardrails page. Null when nothing does.
 */
export function useFinishSetupPieces(): FinishSetupPieces | null {
  const status = useAppaGithubSync().data;
  const protection = useAppaRepositoryProtection(
    status?.selfService?.enabled === true,
  );
  return status?.source?.interval
    ? finishSetupPieces(status, protection.data)
    : null;
}

/**
 * The one notice for whatever the Git sync setup still waits on: the App's
 * permissions, the self-service protection, the pull requests to merge.
 * Finish setup opens the wizard composed from those pieces; who may not
 * change the settings reads the same notice without it.
 */
export function FinishSetupNotice({ pieces }: { pieces: FinishSetupPieces }) {
  const git = appaGitHost(useAppaGithubSync().data);
  const { data: canManage } = useHasPermissions({
    organizationSettings: ["update"],
  });
  return (
    <InlineNotice variant="info">
      <ListChecks aria-hidden />
      <span className="font-medium">Finish the Git sync setup</span>
      <InlineNoticeText className="flex-1">
        {finishSetupSummary(pieces, git.changeRequestShort)}
      </InlineNoticeText>
      {canManage ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="ml-auto"
          data-slot="inline-notice-action"
          onClick={() => openWizard.set(pieces)}
        >
          <span>Finish setup</span>
        </Button>
      ) : null}
    </InlineNotice>
  );
}

/**
 * The wizard {@link FinishSetupNotice} opens, mounted once where the notice
 * shows: in the Guardrails layout and on the Guardrails settings. The notice
 * goes once setup completes, and a wizard of its own would close with it
 * before its Finish step shows what is in place.
 */
export function FinishSetupHost() {
  const pieces = useSyncExternalStore(
    openWizard.subscribe,
    openWizard.get,
    () => null,
  );
  // Leaving the page closes the wizard.
  useEffect(() => () => openWizard.set(null), []);
  return pieces ? (
    <FinishSetupDialog
      pieces={pieces}
      onOpenChange={(open) => {
        if (!open) openWizard.set(null);
      }}
    />
  ) : null;
}

/** The open wizard's pieces as they were when it opened; null while closed. */
const openWizard = (() => {
  let pieces: FinishSetupPieces | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => pieces,
    set: (next: FinishSetupPieces | null) => {
      pieces = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();

/** The pieces in a phrase for the card: "grant …, finish …, merge …". */
export function finishSetupSummary(
  pieces: FinishSetupPieces,
  changeRequestShort: string,
): string {
  const parts: string[] = [];
  if (pieces.permissions.length)
    parts.push(
      `grant the App's ${pieces.permissions
        .map((name) => PERMISSION_LABELS[name])
        .join(" and ")} permission${pieces.permissions.length > 1 ? "s" : ""}`,
    );
  if (pieces.selfService) parts.push("finish the self-service protection");
  if (pieces.pulls.length)
    parts.push(
      `merge ${pieces.pulls
        .map((pull) => `${changeRequestShort} #${pull.number}`)
        .join(" and ")}`,
    );
  const sentence = parts.join(", ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

const PERMISSION_LABELS: Record<Permission, string> = {
  workflows: "Workflows",
  checks: "Checks",
};
const PULL_TITLES: Record<SetupPull["kind"], string> = {
  setup: "Initial policy",
  files: "Repository files update",
  include: "Servers' folder include",
};

type Step = "app" | "pulls" | "finish";
const STEP_LABELS: Record<Step, string> = {
  app: "GitHub App",
  pulls: "Pull requests",
  finish: "Finish",
};

/**
 * One wizard for whatever setup still waits on, its steps composed from the
 * pieces at hand when it opens: the App's missing permissions, the
 * self-service protection, then the pull requests to merge, waited on like
 * the setup one. Pieces that settle meanwhile show as done. Every step shows
 * its own outcome, so none of its syncs toasts.
 */
function FinishSetupDialog({
  pieces: initial,
  onOpenChange,
}: {
  pieces: FinishSetupPieces;
  onOpenChange: (open: boolean) => void;
}) {
  const query = useAppaGithubSync();
  const git = appaGitHost(query.data);
  const protection = useAppaRepositoryProtection(
    query.data?.selfService?.enabled === true,
  );
  // What waits now: a sync while the wizard is open can find more, such as
  // a pull request it just opened or a permission taken away.
  const live = query.data
    ? finishSetupPieces(query.data, protection.data)
    : initial;
  // Steps join as something new waits, in their place, and never leave, so
  // the stepper does not jump under the person using it.
  const [steps, setSteps] = useState<Step[]>(() => stepsFor(initial));
  const wanted = live ? stepsFor(live) : steps;
  if (wanted.some((entry) => !steps.includes(entry)))
    setSteps(
      STEP_ORDER.filter(
        (entry) => steps.includes(entry) || wanted.includes(entry),
      ),
    );
  // Permissions the App step asks for: those at hand when it opened, and
  // any found missing since.
  const [needed, setNeeded] = useState<Permission[]>(initial.permissions);
  const unseen = (live?.permissions ?? []).filter(
    (name) => !needed.includes(name),
  );
  if (unseen.length > 0) setNeeded([...needed, ...unseen]);
  const [current, setCurrent] = useState<Step>(() => steps[0] ?? "finish");
  const index = Math.max(steps.indexOf(current), 0);
  const step = steps[index] ?? "finish";
  const last = index >= steps.length - 1;
  // Every pull request merged: the wizard shows what is in place now.
  const toFinish = useCallback(() => setCurrent("finish"), []);
  const grants = useAppaGithubAppGrants(step === "app");
  const update = useUpdateAppaGithubSync({ quiet: true });
  const syncing = useAppaGithubSyncing();
  // Done syncs at once, so the card shows what was just merged or granted;
  // a sync already running reads the same state, so none is started twice.
  const done = () => {
    if (!syncing) update.mutate({ action: "sync" });
    onOpenChange(false);
  };
  // Opening the wizard syncs, so it starts from what the repository holds
  // and a pull request still to open opens now. The pull requests step
  // syncs as it shows, so a wizard that starts there needs no other.
  const openSynced = useRef(false);
  const { mutate: syncNow } = update;
  const firstStep = steps[0];
  useEffect(() => {
    if (openSynced.current) return;
    openSynced.current = true;
    if (firstStep !== "pulls" && !syncing) syncNow({ action: "sync" });
  }, [firstStep, syncing, syncNow]);
  // The include the self-service folder needs opens as a pull request as
  // soon as it is missing, so the pull requests step lists it with the
  // rest; a setup pull request still to merge takes it onto its branch.
  const fresh = useFreshAppaRepositoryProtection();
  const includeNeeded = live?.includeMissing ?? false;
  const [include, setInclude] = useState<{
    phase: "idle" | "opening" | "opened" | "failed";
    error?: string;
  }>({ phase: "idle" });
  const openInclude = update.mutateAsync;
  const readProtection = fresh.mutateAsync;
  useEffect(() => {
    if (!includeNeeded || include.phase !== "idle") return;
    setInclude({ phase: "opening" });
    openInclude({ action: "include_servers" })
      .then(() => readProtection())
      .then(() => setInclude({ phase: "opened" }))
      .catch((error: unknown) =>
        setInclude({
          phase: "failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }, [includeNeeded, include.phase, openInclude, readProtection]);
  // Opening, or about to: the pull requests step waits for its row.
  const includePending =
    include.phase === "opening" || (includeNeeded && include.phase === "idle");
  const ready = needed.every(
    (name) =>
      grants.data?.permissions.find((entry) => entry.name === name)?.granted ===
      true,
  );
  const header = headerFor(
    step,
    { ...initial, permissions: needed, pulls: live?.pulls ?? initial.pulls },
    git.changeRequest,
  );
  // "the Workflows permission", "the Workflows and Checks permissions"
  const permissions = `the ${needed
    .map((name) => PERMISSION_LABELS[name])
    .join(" and ")} permission${needed.length > 1 ? "s" : ""}`;
  return (
    <StandardDialog
      open
      onOpenChange={onOpenChange}
      title={header.title}
      description={header.description}
      size="medium"
      bodyClassName="space-y-5"
      footer={
        <>
          {last ? null : (
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              <span>Cancel</span>
            </Button>
          )}
          {last ? (
            <Button type="button" onClick={done}>
              <span>Done</span>
            </Button>
          ) : (
            <Button
              type="button"
              disabled={
                (step === "app" && !ready) ||
                (step === "pulls" && includePending)
              }
              onClick={() => setCurrent(steps[index + 1] ?? "finish")}
            >
              <span>Continue</span>
            </Button>
          )}
        </>
      }
    >
      {steps.length > 1 ? (
        <SetupStepper
          steps={steps.map((entry) => STEP_LABELS[entry])}
          current={index}
          onSelect={(target) => setCurrent(steps[target] ?? "finish")}
        />
      ) : null}
      {step === "app" ? (
        <GithubAppPermissionsStep
          grants={grants.data ?? null}
          loading={grants.isPending}
          error={grants.isError ? grants.error.message : undefined}
          checking={grants.isFetching}
          ready={ready}
          onCheckAgain={() => void grants.refetch()}
          needed={needed}
          title={(name) => `Grant ${permissions} to the ${name} App`}
          hint={permissionsHint(needed)}
          readyText={permissions}
        />
      ) : null}
      {step === "finish" ? <SetupChecklist /> : null}
      {step === "pulls" ? (
        <PullRequestsStep
          initial={initial.pulls}
          changeRequestShort={git.changeRequestShort}
          include={{ pending: includePending, error: include.error }}
          onSettled={toFinish}
        />
      ) : null}
    </StandardDialog>
  );
}

/** The wizard's steps, in this order, for what waits. */
const STEP_ORDER: Step[] = ["app", "pulls", "finish"];

function stepsFor(pieces: FinishSetupPieces | null): Step[] {
  if (!pieces) return ["finish"];
  return [
    ...(pieces.permissions.length ? (["app"] as const) : []),
    // A permission granted here proposes a pull request on the next sync,
    // and a missing include is opened as one, so either takes the pull
    // requests step.
    ...(pieces.pulls.length ||
    pieces.permissions.length ||
    pieces.includeMissing
      ? (["pulls"] as const)
      : []),
    // Last, and open again at any time: what is in place and what still
    // waits, the self-service ruleset and include among it.
    "finish" as const,
  ];
}

function headerFor(
  step: Step,
  pieces: FinishSetupPieces,
  changeRequest: string,
): { title: string; description: string } {
  if (step === "app")
    return {
      title: "Finish the GitHub App setup",
      description: `The GitHub App needs ${pieces.permissions.length > 1 ? "two more permissions" : "one more permission"}: ${pieces.permissions.map((name) => permissionPurpose(name, changeRequest)).join("; ")}.`,
    };
  if (step === "finish")
    return {
      title: "Finish setup",
      description: "What is in place, and what still waits for you.",
    };
  // A permission granted on the way opens one more.
  const count = Math.max(pieces.pulls.length, 1);
  return {
    title:
      count === 1
        ? `Merge the ${changeRequest}`
        : `Merge the ${changeRequest}s`,
    description: pieces.pulls.some((pull) => pull.kind === "setup")
      ? "The current policy stays active until the initial policy merges."
      : `Setup finishes once ${count === 1 ? "it merges" : "they merge"}.`,
  };
}

function permissionPurpose(name: Permission, changeRequest: string): string {
  return name === "workflows"
    ? `Workflows writes the validation workflow update through a ${changeRequest}`
    : `Checks posts the policy check on each ${changeRequest}`;
}

function permissionsHint(permissions: Permission[]): ReactNode {
  return (
    <>
      <span>
        Set {permissions.length > 1 ? "both" : "it"} to{" "}
        <strong>Read and write</strong>.
      </span>
      {permissions.includes("workflows") ? (
        <span> Workflows lets the App write the validation workflow.</span>
      ) : null}
      {permissions.includes("checks") ? (
        <span>
          {" "}
          Checks posts the check&apos;s verdict on each pull request.
        </span>
      ) : null}
    </>
  );
}

/** How long merged rows show before the wizard moves on to Finish. */
const SETTLED_PAUSE_MS = 1200;

/**
 * The pull requests to merge, as the status reports them now: one sync when
 * the step shows, so its rows start current and a permission just granted
 * opens the pull request it unblocks, and one each time the tab comes back
 * from the host while any still waits. A pull request keeps its row once it
 * merges, marked merged; once a sync finds none waiting, the wizard moves on
 * to its Finish step.
 */
function PullRequestsStep({
  initial,
  changeRequestShort,
  include,
  onSettled,
}: {
  initial: SetupPull[];
  changeRequestShort: string;
  /** The include's pull request the wizard opens: still to come, or failed. */
  include: { pending: boolean; error?: string };
  /** Every pull request merged, as a sync read it: on to Finish. */
  onSettled: () => void;
}) {
  const query = useAppaGithubSync();
  const protection = useAppaRepositoryProtection(
    query.data?.selfService?.enabled === true,
  );
  const update = useUpdateAppaGithubSync({ quiet: true });
  const syncing = useAppaGithubSyncing();
  const { mutate } = update;
  const live = query.data
    ? (finishSetupPieces(query.data, protection.data)?.pulls ?? [])
    : initial;
  const waiting = live.length > 0;
  // Every pull request the step has shown, those it opened with first.
  const [seen, setSeen] = useState(initial);
  const unseen = live.filter(
    (pull) => !seen.some((entry) => samePull(entry, pull)),
  );
  if (unseen.length > 0) setSeen([...seen, ...unseen]);
  // Whether a sync ended while the step showed: its answer replaces the
  // status before it ends, so the rows are what it read.
  const [synced, setSynced] = useState(false);
  const sync = useCallback(
    () => mutate({ action: "sync" }, { onSuccess: () => setSynced(true) }),
    [mutate],
  );
  // A sync started elsewhere counts too, once it ends.
  const wasSyncing = useRef(syncing);
  useEffect(() => {
    if (wasSyncing.current && !syncing) setSynced(true);
    wasSyncing.current = syncing;
  }, [syncing]);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // A sync already running reads the same state.
    if (!syncing) sync();
  }, [syncing, sync]);
  useEffect(() => {
    if (!waiting) return;
    const check = () => {
      if (document.visibilityState === "visible" && !syncing) sync();
    };
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [waiting, syncing, sync]);
  const settled = synced && !syncing && !waiting && !include.pending;
  useEffect(() => {
    if (!settled) return;
    const timer = window.setTimeout(onSettled, SETTLED_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [settled, onSettled]);
  // A pull request that no longer waits merged, unless a newer one of its
  // kind took its place (GitLab opens each update anew): that one goes.
  const rows = seen
    .filter(
      (pull) =>
        live.some((open) => samePull(open, pull)) ||
        !live.some((open) => open.kind === pull.kind),
    )
    .map((pull) => ({
      ...pull,
      merged: !live.some((open) => samePull(open, pull)),
    }));
  const checked = query.data?.source?.lastSyncedAt
    ? formatRelativeTimeFromNow(query.data.source.lastSyncedAt).toLowerCase()
    : null;
  const failures = (
    <>
      {include.error ? (
        <InlineNotice variant="error">
          <AlertTriangle aria-hidden />
          <span className="font-medium">
            {`Could not open the ${changeRequestShort} for the servers' folder`}
          </span>
          <InlineNoticeText className="flex-1">
            {include.error}
          </InlineNoticeText>
        </InlineNotice>
      ) : null}
      {query.data?.source?.lastSyncError ? (
        <InlineNotice variant="error">
          <AlertTriangle aria-hidden />
          <span className="font-medium">Could not sync</span>
          <InlineNoticeText className="flex-1">
            {query.data.source.lastSyncError}
          </InlineNoticeText>
        </InlineNotice>
      ) : null}
    </>
  );
  // The include's pull request is still being opened: its row waits for it.
  const opening =
    include.pending && !rows.some((pull) => pull.kind === "include");
  if (rows.length === 0 && !opening)
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          {syncing ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
          ) : (
            <CheckCircle2
              className="size-4 text-emerald-600 dark:text-emerald-400"
              aria-hidden
            />
          )}
          <span>
            {syncing
              ? "Syncing…"
              : `Nothing waits for a ${changeRequestShort}.`}
          </span>
        </p>
        {failures}
      </div>
    );
  return (
    <div className="space-y-3">
      <div className="divide-y rounded-lg border bg-card" aria-live="polite">
        {rows.map((pull) => (
          <div
            key={`${pull.kind}-${pull.number}`}
            className="flex items-center gap-3 p-4"
          >
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
              <GitPullRequestArrow className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <a
                className="block truncate text-sm font-medium hover:underline underline-offset-4"
                href={pull.url}
                target="_blank"
                rel="noreferrer"
              >
                {PULL_TITLES[pull.kind]}{" "}
                <span className="font-normal text-muted-foreground">
                  #{pull.number}
                </span>
              </a>
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                {pull.merged ? (
                  <span>Merged</span>
                ) : (
                  <>
                    <LoaderCircle
                      className={cn("size-3", syncing && "animate-spin")}
                      aria-hidden
                    />
                    <span>
                      {syncing
                        ? "Checking…"
                        : checked
                          ? `Waiting for merge · checked ${checked}`
                          : "Waiting for merge"}
                    </span>
                  </>
                )}
              </p>
            </div>
            {pull.merged ? (
              <Badge variant="outline">
                <CheckCircle2 className="text-emerald-600 dark:text-emerald-400" />
                <span>Merged</span>
              </Badge>
            ) : (
              <Button asChild size="sm" variant="outline">
                <a href={pull.url} target="_blank" rel="noreferrer">
                  <span>Review and merge</span>
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              </Button>
            )}
          </div>
        ))}
        {opening ? (
          <div className="flex items-center gap-3 p-4">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
              <GitPullRequestArrow className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {PULL_TITLES.include}
              </p>
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <LoaderCircle className="size-3 animate-spin" aria-hidden />
                <span>{`Opening the ${changeRequestShort}…`}</span>
              </p>
            </div>
          </div>
        ) : null}
      </div>
      {failures}
    </div>
  );
}

function samePull(left: SetupPull, right: SetupPull): boolean {
  return left.kind === right.kind && left.number === right.number;
}
