"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { ArrowLeft, Check, LoaderCircle, RefreshCw } from "lucide-react";
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
const NEEDED = ["administration", "checks"] as const;
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
 * App's permissions, the folder the servers' files go in, then the switch
 * itself with what it brings, the branch ruleset and the pull request that
 * starts the folder and includes it. Already on, the folder is fixed and
 * the last step brings what is still missing.
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
        <AppStep
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
      description: `${appName} posts the policy check on each pull request and keeps a branch ruleset that requires it. The ${githubApp ? `${githubApp} App` : "GitHub App"} needs two more permissions for that.`,
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
  administration: "Administration",
} as const;

/** The App's permissions: what it has, and where to grant the rest. */
function AppStep({
  grants,
  loading,
  error,
  checking,
  ready,
  onCheckAgain,
}: {
  grants: Grants | null;
  loading: boolean;
  error?: string;
  checking: boolean;
  ready: boolean;
  onCheckAgain: () => void;
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
            "Self-service needs a GitHub App: connect the policy repository through one first."}
        </InlineNoticeText>
      </InlineNotice>
    );
  const missing = NEEDED.filter(
    (name) =>
      grants.permissions.find((entry) => entry.name === name)?.granted !== true,
  );
  return (
    <div className="space-y-4">
      <ol className="overflow-hidden rounded-lg border bg-card">
        <ManifestRow
          index={1}
          title={
            <>
              Grant <code>Administration</code> and <code>Checks</code>{" "}
              permissions to the {grants.name} App
            </>
          }
          hint={
            <>
              Set both to <code>Read and write</code>. Checks posts the verdict
              on each pull request; Administration makes it required on the
              branch.
            </>
          }
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
          title="Accept new permissions"
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
            The {grants.name} App has every permission self-service needs.
          </span>
        ) : (
          <span>
            Missing:{" "}
            {joined(
              missing.map((name) => PERMISSION_LABELS[name]),
              " and ",
            )}
            . Check again once both are accepted.
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
 * branch ruleset, and the pull request that starts the folder and includes
 * it. Runs once when shown; a failed part offers a retry. The Git sync
 * wizard shows it too, so the dialog stays open on the pull request.
 */
export function SelfServiceOutcomeStep({
  run: first,
  labels,
  directory,
  policyFile,
}: {
  /** The first row's work; the rest reads the protection once it settles. */
  run: () => Promise<unknown>;
  labels: { pending: string; done: string; failed: string };
  directory: string;
  policyFile: string;
}) {
  const update = useUpdateAppaGithubSync();
  const protection = useAppaRepositoryProtection(false);
  const [switched, setSwitched] = useState<Progress>("waiting");
  const [rules, setRules] = useState<{
    state: Progress;
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
  const refetch = protection.refetch;

  async function run() {
    try {
      setSwitched("running");
      await first();
      setSwitched("done");
      setRules({ state: "running" });
      setInclude({ state: "running" });
      const read = (await refetch()).data ?? null;
      setRules(
        read?.branchRules.state === "active"
          ? { state: "done", detail: read.branchRules, name: read.checkName }
          : {
              state: "failed",
              detail: read?.branchRules,
              name: read?.checkName,
            },
      );
      if (
        read?.include.state === "included" ||
        read?.include.state === "pull_open"
      ) {
        setInclude({ state: "done", detail: read.include });
        return;
      }
      try {
        await mutate({ action: "include_servers" });
        const again = (await refetch()).data ?? null;
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
    } catch (error) {
      setSwitched("failed");
      setRules({ state: "waiting" });
      setInclude({
        state: "waiting",
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    if (rules.state === "done" && detail?.url)
      return (
        <span>
          Branch ruleset created:{" "}
          <a
            href={detail.url}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground underline underline-offset-4"
          >
            {rules.name ?? "ruleset"}
          </a>
        </span>
      );
    if (rules.state === "failed")
      return (
        <span>
          Branch ruleset not created yet
          {detail?.detail ? `: ${detail.detail}` : "."}{" "}
          <span>It is set up at the next sync.</span>
        </span>
      );
    return <span>Create the branch ruleset</span>;
  })();
  const includeLine = (() => {
    const detail = include.detail;
    if (include.state === "done" && detail?.state === "included")
      return (
        <span>
          {policyFile} already includes <code>{directory}/*.toml</code>.
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
          <span>
            {switched === "done"
              ? labels.done
              : switched === "failed"
                ? `${labels.failed}${include.error ? `: ${include.error}` : "."}`
                : labels.pending}
          </span>
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
                      result.data?.include.state === "missing"
                        ? "failed"
                        : "done",
                    detail: result.data?.include,
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

function ProgressRow({
  state,
  children,
}: {
  state: Progress;
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
      ) : state === "failed" ? (
        <span className="mt-1 flex size-4 shrink-0 items-center justify-center">
          <span className="size-2 rounded-full bg-amber-500" />
          <span className="sr-only">Failed</span>
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
