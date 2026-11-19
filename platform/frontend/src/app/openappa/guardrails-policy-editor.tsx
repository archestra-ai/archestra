"use client";

import {
  BookOpen,
  GitBranch,
  LockKeyhole,
  MessageSquare,
  PanelBottom,
  PanelRight,
  SquarePen,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SERVER_RULES_LABEL,
  ServerRulesButton,
} from "@/app/mcp/registry/_parts/server-rules-launch";
import {
  FileKindChip,
  FilePathLabel,
  FileWorkspace,
  FileWorkspaceNotice,
  IconBadge,
  IconLink,
  WorkspacePanelToggle,
} from "@/components/file-workspace/file-workspace";
import { useStoredFlag } from "@/components/file-workspace/use-stored-flag";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  type PolicyDeclarations,
  useEffectivePolicy,
} from "@/lib/openappa-batteries.query";
import { cn } from "@/lib/utils/tailwind";
import { BatteryEditDialog } from "./_parts/batteries-panel";
import { BATTERY_PROBLEM } from "./_parts/battery-status";
import { compositionOf } from "./_parts/composition-view";
import { EffectivePolicyView } from "./_parts/effective-policy-view";
import { GithubManagedPolicyNotice } from "./_parts/github-managed-policy-notice";
import { OpenAppaChatButton } from "./_parts/openappa-chat-button";
import { PolicyExplorer } from "./_parts/policy-explorer";
import {
  POLICY_FILE_KIND,
  PolicyStatusDot,
  policyFileIcon,
} from "./_parts/policy-file-kind";
import { PolicyOutline } from "./_parts/policy-outline";
import {
  PolicyProblemsPanel,
  type ValidationProblem,
  validationProblems,
} from "./_parts/policy-problems-panel";
import { policyQuickOpen } from "./_parts/policy-quick-open";
import {
  PolicyPaneSkeleton,
  PolicyReadOnlyMessage,
  PolicySourcePane,
} from "./_parts/policy-source-pane";
import {
  POLICY_VALIDATION_CSS,
  PolicyValidationPane,
} from "./_parts/policy-validation-pane";
import {
  type PolicyWorkspace,
  usePolicyWorkspace,
} from "./_parts/use-policy-workspace";
import {
  ValidationProvider,
  validationEntry,
} from "./_parts/validation-context";

/**
 * The Policy page, laid out as an editor: the policy's files in an explorer,
 * the open one read-only beside it with its rules outlined, and one bar on
 * top. It takes the height its page gives it.
 */
export function GuardrailsPolicyEditor() {
  return (
    <ValidationProvider>
      <PolicyEditor />
    </ValidationProvider>
  );
}

function PolicyEditor() {
  const workspace = usePolicyWorkspace();
  const [outlineOpen, setOutlineOpen] = useStoredFlag(
    "openappa-policy-outline-open",
  );
  const [problemsOpen, setProblemsOpen] = useStoredFlag(
    "openappa-policy-problems-open",
  );
  const [fixingBattery, setFixingBattery] = useState<string | null>(null);

  const batteryProblem =
    workspace.active.kind === "battery" &&
    workspace.active.status &&
    workspace.active.status !== "active"
      ? BATTERY_PROBLEM[workspace.active.status]
      : null;
  const suite = workspace.validations;
  const problems = useMemo(
    () => (suite ? validationProblems(suite) : []),
    [suite],
  );
  const [activeProblemId, setActiveProblemId] = useState<string>();
  const { open: openEntry } = workspace;
  const pickProblem = useCallback(
    (problem: ValidationProblem) => {
      setActiveProblemId(problem.id);
      openEntry(validationEntry(problem.path), problem.line);
    },
    [openEntry],
  );
  // F8 walks the problems, wrapping at either end.
  const stepProblem = useCallback(
    (direction: 1 | -1) => {
      if (problems.length === 0) return;
      const at = problems.findIndex((item) => item.id === activeProblemId);
      const next =
        at < 0
          ? direction === 1
            ? 0
            : problems.length - 1
          : (at + direction + problems.length) % problems.length;
      pickProblem(problems[next]);
    },
    [problems, activeProblemId, pickProblem],
  );
  const keys = useRef({ stepProblem, problemsOpen, setProblemsOpen });
  keys.current = { stepProblem, problemsOpen, setProblemsOpen };
  const hasValidations = suite !== null;

  // Cmd/Ctrl+J folds the problems and F8 walks them, as in an IDE; the
  // workspace opens the file palette on Cmd/Ctrl+P. Capture phase, so the
  // editor does not take the key first.
  useEffect(() => {
    if (!hasValidations) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const command = (event.metaKey || event.ctrlKey) && !event.altKey;
      if (command && !event.shiftKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        keys.current.setProblemsOpen(!keys.current.problemsOpen);
      } else if (event.key === "F8") {
        event.preventDefault();
        keys.current.stepProblem(event.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [hasValidations]);

  const isSource = workspace.view === "source";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* A healthy sync is the bar's repository icon; this asks for something. */}
      {workspace.managed && <GithubManagedPolicyNotice hideHealthy />}
      <Tabs
        className="min-h-0 flex-1 gap-0"
        value={workspace.view}
        onValueChange={(next) =>
          workspace.setView(next === "effective" ? next : "source")
        }
      >
        <FileWorkspace
          className="flex-1"
          explorerStorageKey="openappa-policy-explorer-open"
          explorer={
            isSource
              ? (overlay) => (
                  <PolicyExplorer workspace={workspace} overlay={overlay} />
                )
              : null
          }
          activeKey={workspace.active.key}
          shortcutScope="window"
          quickOpenLabel="Open a policy file"
          quickOpen={policyQuickOpen(workspace)}
          title={<PolicyBarTitle workspace={workspace} />}
          actions={
            <PolicyBarActions
              workspace={workspace}
              outlineOpen={outlineOpen}
              onToggleOutline={() => setOutlineOpen(!outlineOpen)}
              problemsOpen={suite ? problemsOpen : null}
              onToggleProblems={() => setProblemsOpen(!problemsOpen)}
            />
          }
          notice={
            workspace.notice && (
              <FileWorkspaceNotice
                data-testid="composition-notice"
                variant={workspace.notice.variant}
                title={workspace.notice.title}
              >
                {workspace.notice.body}
              </FileWorkspaceNotice>
            )
          }
        >
          <TabsContent
            value="source"
            className="flex min-h-0 min-w-0 flex-1 flex-col"
          >
            <div className="flex min-h-0 flex-1">
              {workspace.isPending || !workspace.active.key ? (
                // Whose files these are is not known yet: nothing to read.
                <PolicyPaneSkeleton className="min-w-0 flex-1" />
              ) : workspace.active.kind === "validation" ? (
                <PolicyValidationPane
                  className="min-w-0 flex-1"
                  path={workspace.active.path}
                  focusLine={workspace.focusLine}
                  repositoryUrl={workspace.editUrl}
                  onDeleted={() => workspace.open(null)}
                />
              ) : (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  {batteryProblem && (
                    // What is wrong is in the battery's settings, not in this file.
                    <p className="flex shrink-0 items-start gap-2 border-b bg-amber-500/10 px-3 py-1 text-xs text-amber-700 dark:text-amber-400">
                      <TriangleAlert
                        className="mt-0.5 size-3.5 shrink-0"
                        aria-hidden
                      />
                      <span className="min-w-0">
                        <span>{batteryProblem.text}</span>{" "}
                        <UnstyledButton
                          onClick={() =>
                            setFixingBattery(
                              workspace.active.batteryName ?? null,
                            )
                          }
                          className="font-medium underline underline-offset-2 outline-none hover:text-foreground focus-visible:text-foreground"
                        >
                          {batteryProblem.action}
                        </UnstyledButton>
                      </span>
                    </p>
                  )}
                  <PolicyReadOnlyMessage.Provider
                    value={
                      workspace.editUrl
                        ? `Read-only. [Edit in ${workspace.gitLabel}](${workspace.editUrl})`
                        : workspace.active.kind === "battery"
                          ? "Read-only. A battery's rules come with the battery."
                          : workspace.canChangeInChat
                            ? "Read-only. Ask the configuration agent in chat to change it."
                            : null
                    }
                  >
                    <PolicySourcePane
                      className="min-h-0 min-w-0 flex-1"
                      file={workspace.active}
                      files={workspace.files}
                      focusLine={workspace.focusLine}
                      onOpenEntry={workspace.open}
                      serverRules={workspace.scoped}
                    />
                  </PolicyReadOnlyMessage.Provider>
                </div>
              )}
              {outlineOpen && workspace.active.kind !== "validation" && (
                <PolicyOutline workspace={workspace} />
              )}
            </div>
            {suite && (
              <PolicyProblemsPanel
                suite={suite}
                problems={problems}
                open={problemsOpen}
                onOpenChange={setProblemsOpen}
                activeId={activeProblemId}
                onPick={pickProblem}
                onOpenFile={(path) => workspace.open(validationEntry(path))}
                onStep={stepProblem}
              />
            )}
          </TabsContent>
          <TabsContent
            value="effective"
            className="flex min-h-0 flex-1 flex-col"
          >
            <EffectivePolicyView />
          </TabsContent>
        </FileWorkspace>
      </Tabs>
      {fixingBattery && (
        <BatteryEditDialog
          name={fixingBattery}
          onClose={() => setFixingBattery(null)}
        />
      )}
      <style>{POLICY_VALIDATION_CSS}</style>
    </div>
  );
}

/** The bar's middle: the open file, or what the effective view shows. */
function PolicyBarTitle({ workspace }: { workspace: PolicyWorkspace }) {
  const isSource = workspace.view === "source";
  const effective = useEffectivePolicy(!isSource);
  const { active } = workspace;
  const kind = POLICY_FILE_KIND[active.kind];
  const KindIcon = policyFileIcon(active);
  if (!isSource)
    return (
      <>
        <span className="shrink-0 font-medium text-foreground">
          Effective policy
        </span>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
          {effective.data && effective.data.lastError !== null
            ? servedHeading(compositionOf(effective.data))
            : "What the runtime enforces, batteries included."}
        </span>
      </>
    );
  return (
    <>
      <KindIcon
        className={cn("size-3.5 shrink-0", kind.iconClass)}
        aria-hidden
      />
      <FilePathLabel path={active.path} />
      <FileKindChip data-testid="policy-file-kind" className={kind.chipClass}>
        {active.mcpServerRules ? "MCP server rules" : kind.label}
      </FileKindChip>
      {active.severity && (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          <PolicyStatusDot severity={active.severity} />
          <span className="hidden sm:inline">{active.statusLabel}</span>
        </span>
      )}
      {workspace.focusLine && (
        <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">{`Line ${workspace.focusLine}`}</span>
      )}
    </>
  );
}

/** The bar's end: where the open file is changed, the views, the panels. */
function PolicyBarActions({
  workspace,
  outlineOpen,
  onToggleOutline,
  problemsOpen,
  onToggleProblems,
}: {
  workspace: PolicyWorkspace;
  outlineOpen: boolean;
  onToggleOutline: () => void;
  /** Null when there are no validations to have problems. */
  problemsOpen: boolean | null;
  onToggleProblems: () => void;
}) {
  const isSource = workspace.view === "source";
  const { active } = workspace;
  // A reader of MCP servers' rules changes a file from the server it governs.
  const editServer =
    workspace.scoped && active.canEdit ? active.servers?.[0] : undefined;
  const serverNames = (active.servers ?? [])
    .map((server) => server.name)
    .join(", ");
  const validation = active.kind === "validation";
  const suite = workspace.validations;
  const readOnly = validation
    ? suite?.github
      ? "Read-only. Change this validation in "
      : suite?.canWrite
        ? null
        : "Read-only. Ask an administrator to change this validation."
    : workspace.scoped
      ? active.canEdit
        ? `Read-only here. ${SERVER_RULES_LABEL} proposes a change as a pull request.`
        : `Read-only. Changing these rules takes edit access to ${serverNames || "the server"} in the MCP registry.`
      : workspace.managed
        ? active.kind === "repository"
          ? "Read-only. Change this file in its connected repository."
          : "Read-only. Change this policy in its connected repository."
        : workspace.canChangeInChat
          ? "Read-only. Change this policy with the configuration agent in chat."
          : "Read-only. Ask an administrator to change this policy.";
  const managedIn = `Managed in ${workspace.gitLabel}`;

  return (
    <>
      {readOnly && (
        <IconBadge
          label={
            validation && suite?.github
              ? `${readOnly}its repository.`
              : readOnly
          }
          tooltip={
            validation && suite?.github ? (
              <>
                <span>{readOnly}</span>
                {workspace.editUrl ? (
                  <a
                    href={workspace.editUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline underline-offset-2"
                  >
                    its repository
                  </a>
                ) : (
                  <span>its repository</span>
                )}
                <span>.</span>
              </>
            ) : undefined
          }
        >
          <LockKeyhole className="size-3.5" aria-hidden />
        </IconBadge>
      )}
      {workspace.managed &&
        (workspace.repositoryUrl ? (
          <IconLink href={workspace.repositoryUrl} label={managedIn}>
            <GitBranch className="size-3.5" />
          </IconLink>
        ) : (
          <IconBadge label={managedIn}>
            <GitBranch className="size-3.5" aria-hidden />
          </IconBadge>
        ))}
      {workspace.editUrl && isSource && (
        <IconLink href={workspace.editUrl} label="Edit in repository">
          <SquarePen className="size-3.5" />
        </IconLink>
      )}
      <IconLink href={workspace.guideUrl} label="Policy guide">
        <BookOpen className="size-3.5" />
      </IconLink>
      {editServer && isSource && (
        <ServerRulesButton
          catalog={editServer}
          size="xs"
          variant="ghost"
          className="h-6 px-1.5 text-xs"
        >
          <SquarePen className="size-3.5" aria-hidden />
          <span className="sr-only xl:not-sr-only">{SERVER_RULES_LABEL}</span>
        </ServerRulesButton>
      )}
      {workspace.canChangeInChat && !validation && (
        <OpenAppaChatButton
          size="xs"
          variant="ghost"
          className="h-6 px-1.5 text-xs"
        >
          <MessageSquare className="size-3.5" aria-hidden />
          <span className="sr-only xl:not-sr-only">Change in chat</span>
        </OpenAppaChatButton>
      )}
      {/* The composed policy is the organization's: not a server reader's. */}
      {!workspace.scoped && (
        <TabsList size="sm" aria-label="Policy view" className="mx-1 h-6">
          <TabsTrigger value="source" className="h-5 text-[11px]">
            Source
          </TabsTrigger>
          <TabsTrigger value="effective" className="h-5 text-[11px]">
            Effective
          </TabsTrigger>
        </TabsList>
      )}
      {isSource && problemsOpen !== null && (
        <WorkspacePanelToggle
          label={problemsOpen ? "Hide problems" : "Show problems"}
          tooltip={problemsOpen ? "Hide problems (⌘J)" : "Show problems (⌘J)"}
          pressed={problemsOpen}
          onClick={onToggleProblems}
          className="hidden md:inline-flex"
        >
          <PanelBottom className="size-3.5" />
        </WorkspacePanelToggle>
      )}
      {isSource && !validation && (
        <WorkspacePanelToggle
          label={outlineOpen ? "Hide rule outline" : "Show rule outline"}
          pressed={outlineOpen}
          onClick={onToggleOutline}
          className="hidden lg:inline-flex"
        >
          <PanelRight className="size-3.5" />
        </WorkspacePanelToggle>
      )}
    </>
  );
}

/** What the effective view says it shows while the latest attempt is refused. */
function servedHeading(composition: PolicyDeclarations["composition"]): string {
  const { served, refusal } = composition;
  if (served.kind === "root_only")
    return "Nothing is enforced: the root text alone";
  if (served.kind === "current" || served.rootRevision === null)
    return "Still enforced: the last composition that opened";
  return served.rootRevision === refusal?.rootRevision
    ? `Still enforced: the earlier composition of revision ${served.rootRevision}`
    : `Still enforced: revision ${served.rootRevision}`;
}
