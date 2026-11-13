"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  CheckCircle2,
  ExternalLink,
  GitPullRequestArrow,
  ListChecks,
  LoaderCircle,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
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
  const selfService =
    status.selfService?.enabled &&
    protection &&
    (protection.branchRules.state !== "active" ||
      protection.include.state === "missing")
      ? {
          directory: status.selfService?.directory ?? "mcp",
          policyFile: source.path.slice(source.path.lastIndexOf("/") + 1),
        }
      : null;
  if (permissions.length === 0 && !selfService && pulls.length === 0)
    return null;
  return { permissions, selfService, pulls };
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
  const [open, setOpen] = useState(false);
  return (
    <>
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
            onClick={() => setOpen(true)}
          >
            <span>Finish setup</span>
          </Button>
        ) : null}
      </InlineNotice>
      {open ? (
        <FinishSetupDialog pieces={pieces} onOpenChange={setOpen} />
      ) : null}
    </>
  );
}

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
 * the setup one. Pieces that settle meanwhile show as done.
 */
export function FinishSetupDialog({
  pieces: initial,
  onOpenChange,
}: {
  pieces: FinishSetupPieces;
  onOpenChange: (open: boolean) => void;
}) {
  const [steps] = useState<Step[]>(() => [
    ...(initial.permissions.length ? (["app"] as const) : []),
    // A permission granted here proposes a pull request on the next sync,
    // so the pull requests step follows the App step always.
    ...(initial.pulls.length || initial.permissions.length
      ? (["pulls"] as const)
      : []),
    // Last, and open again at any time: what is in place and what still
    // waits, the self-service ruleset and include among it.
    "finish" as const,
  ]);
  const [index, setIndex] = useState(0);
  const step = steps[index] ?? "finish";
  const last = index >= steps.length - 1;
  const query = useAppaGithubSync();
  const git = appaGitHost(query.data);
  const grants = useAppaGithubAppGrants(step === "app");
  const update = useUpdateAppaGithubSync();
  const syncing = useAppaGithubSyncing();
  // Done syncs at once, so the card shows what was just merged or granted;
  // a sync already running reads the same state, so none is started twice.
  const done = () => {
    if (!syncing) update.mutate({ action: "sync" });
    onOpenChange(false);
  };
  const ready = initial.permissions.every(
    (name) =>
      grants.data?.permissions.find((entry) => entry.name === name)?.granted ===
      true,
  );
  const header = headerFor(step, initial, git.changeRequest);
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
              disabled={step === "app" && !ready}
              onClick={() => setIndex(index + 1)}
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
          onSelect={setIndex}
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
          needed={initial.permissions}
          title={(name) => (
            <>
              Grant the {joinCodes(initial.permissions)} permission
              {initial.permissions.length > 1 ? "s" : ""} to the {name} App
            </>
          )}
          hint={permissionsHint(initial.permissions)}
          readyText={`the ${initial.permissions
            .map((name) => PERMISSION_LABELS[name])
            .join(
              " and ",
            )} permission${initial.permissions.length > 1 ? "s" : ""}`}
        />
      ) : null}
      {step === "finish" ? <SetupChecklist /> : null}
      {step === "pulls" ? (
        <PullRequestsStep
          initial={initial.pulls}
          syncFirst={initial.permissions.length > 0}
          changeRequestShort={git.changeRequestShort}
        />
      ) : null}
    </StandardDialog>
  );
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
        <code>Read and write</code>.
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

function joinCodes(names: Permission[]): ReactNode {
  return names.map((name, index) => (
    <span key={name}>
      {index > 0 ? <span> and </span> : null}
      <code>{PERMISSION_LABELS[name]}</code>
    </span>
  ));
}

/**
 * The pull requests to merge, as the status reports them now: one sync when
 * a permission was just granted, so the pull request it unblocks opens, and
 * one each time the tab comes back from the host while any still waits.
 */
function PullRequestsStep({
  initial,
  syncFirst,
  changeRequestShort,
}: {
  initial: SetupPull[];
  syncFirst: boolean;
  changeRequestShort: string;
}) {
  const query = useAppaGithubSync();
  const protection = useAppaRepositoryProtection(
    query.data?.selfService?.enabled === true,
  );
  const update = useUpdateAppaGithubSync();
  const started = useRef(false);
  const { mutate, isPending } = update;
  const live = query.data
    ? (finishSetupPieces(query.data, protection.data)?.pulls ?? [])
    : initial;
  const waiting = live.length > 0;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (syncFirst) mutate({ action: "sync" });
  }, [syncFirst, mutate]);
  useEffect(() => {
    if (!waiting) return;
    const check = () => {
      if (document.visibilityState === "visible" && !isPending)
        mutate({ action: "sync" });
    };
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [waiting, isPending, mutate]);
  // Every pull request that waits, plus those the wizard opened with that
  // no longer do: merged, unless a newer one of their kind took their place.
  const rows: Array<SetupPull & { merged: boolean }> = [
    ...live.map((pull) => ({ ...pull, merged: false })),
    ...initial
      .filter((pull) => !live.some((open) => open.kind === pull.kind))
      .map((pull) => ({ ...pull, merged: true })),
  ];
  const checked = query.data?.source?.lastSyncedAt
    ? formatRelativeTimeFromNow(query.data.source.lastSyncedAt).toLowerCase()
    : null;
  if (rows.length === 0)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        {isPending ? (
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
        ) : (
          <CheckCircle2
            className="size-4 text-emerald-600 dark:text-emerald-400"
            aria-hidden
          />
        )}
        <span>
          {isPending
            ? "Syncing…"
            : `Nothing waits for a ${changeRequestShort}.`}
        </span>
      </p>
    );
  return (
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
                    className={cn("size-3", isPending && "animate-spin")}
                    aria-hidden
                  />
                  <span>
                    {isPending
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
    </div>
  );
}
