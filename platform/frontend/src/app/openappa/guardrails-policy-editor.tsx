"use client";

import {
  BookOpen,
  GitBranch,
  LockKeyhole,
  MessageSquare,
  PanelLeft,
  PanelRight,
  Search,
  SquarePen,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  SERVER_RULES_LABEL,
  ServerRulesButton,
} from "@/app/mcp/registry/_parts/server-rules-launch";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  type PolicyDeclarations,
  useEffectivePolicy,
} from "@/lib/openappa-batteries.query";
import { cn } from "@/lib/utils/tailwind";
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
import { PolicyQuickOpen } from "./_parts/policy-quick-open";
import {
  PolicyPaneSkeleton,
  PolicySourcePane,
} from "./_parts/policy-source-pane";
import {
  type PolicyWorkspace,
  usePolicyWorkspace,
} from "./_parts/use-policy-workspace";

/**
 * The Policy page, laid out as an editor: the policy's files in an explorer,
 * the open one read-only beside it with its rules outlined, and one bar on
 * top. It takes the height its page gives it.
 */
export function GuardrailsPolicyEditor() {
  const workspace = usePolicyWorkspace();
  const [explorerOpen, setExplorerOpen] = useStoredFlag(
    "openappa-policy-explorer-open",
  );
  const [outlineOpen, setOutlineOpen] = useStoredFlag(
    "openappa-policy-outline-open",
  );
  const [quickOpen, setQuickOpen] = useState(false);

  // Cmd/Ctrl+P opens the file palette, as in an IDE. Capture phase, so the
  // editor does not take the key first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "p"
      ) {
        event.preventDefault();
        setQuickOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* A healthy sync is the bar's repository icon; this asks for something. */}
      {workspace.managed && <GithubManagedPolicyNotice hideHealthy />}
      <Tabs
        className="min-h-0 flex-1 gap-0 overflow-hidden rounded-lg border bg-background"
        value={workspace.view}
        onValueChange={(next) =>
          workspace.setView(next === "effective" ? next : "source")
        }
      >
        <TopBar
          workspace={workspace}
          explorerOpen={explorerOpen}
          onToggleExplorer={() => setExplorerOpen(!explorerOpen)}
          outlineOpen={outlineOpen}
          onToggleOutline={() => setOutlineOpen(!outlineOpen)}
          onQuickOpen={() => setQuickOpen(true)}
        />
        {workspace.notice && (
          <div
            role="alert"
            data-testid="composition-notice"
            className={cn(
              "flex h-7 shrink-0 items-center gap-2 border-b px-3 text-xs",
              workspace.notice.variant === "error"
                ? "bg-destructive/10 text-destructive"
                : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
            )}
          >
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            <span className="shrink-0 font-medium">
              {workspace.notice.title}
            </span>
            <span
              className="min-w-0 truncate opacity-90"
              title={workspace.notice.body}
            >
              {workspace.notice.body}
            </span>
          </div>
        )}
        <TabsContent value="source" className="flex min-h-0">
          {explorerOpen && <PolicyExplorer workspace={workspace} />}
          {workspace.isPending || !workspace.active.key ? (
            // Whose files these are is not known yet: nothing to read.
            <PolicyPaneSkeleton className="min-w-0 flex-1" />
          ) : (
            <PolicySourcePane
              className="min-w-0 flex-1"
              file={workspace.active}
              files={workspace.files}
              focusLine={workspace.focusLine}
              onOpenEntry={workspace.open}
              serverRules={workspace.scoped}
            />
          )}
          {outlineOpen && <PolicyOutline workspace={workspace} />}
        </TabsContent>
        <TabsContent value="effective" className="flex min-h-0 flex-col">
          <EffectivePolicyView />
        </TabsContent>
      </Tabs>
      <PolicyQuickOpen
        workspace={workspace}
        open={quickOpen}
        onOpenChange={setQuickOpen}
      />
    </div>
  );
}

function TopBar({
  workspace,
  explorerOpen,
  onToggleExplorer,
  outlineOpen,
  onToggleOutline,
  onQuickOpen,
}: {
  workspace: PolicyWorkspace;
  explorerOpen: boolean;
  onToggleExplorer: () => void;
  outlineOpen: boolean;
  onToggleOutline: () => void;
  onQuickOpen: () => void;
}) {
  const isSource = workspace.view === "source";
  const effective = useEffectivePolicy(!isSource);
  const isMac = useIsMac();
  const { active } = workspace;
  const kind = POLICY_FILE_KIND[active.kind];
  const KindIcon = policyFileIcon(active);
  const slash = active.path.lastIndexOf("/");
  // A reader of MCP servers' rules changes a file from the server it governs.
  const editServer =
    workspace.scoped && active.canEdit ? active.servers?.[0] : undefined;
  const serverNames = (active.servers ?? [])
    .map((server) => server.name)
    .join(", ");
  const readOnly = workspace.scoped
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
    // On a phone the actions take the first row and the file the second.
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b bg-muted/40 p-1 sm:grid sm:h-8 sm:grid-cols-[1fr_minmax(0,30rem)_1fr] sm:py-0">
      <div className="hidden items-center sm:flex">
        {isSource && (
          <IconAction
            label={explorerOpen ? "Hide files" : "Show files"}
            className="hidden md:inline-flex"
          >
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={explorerOpen ? "Hide files" : "Show files"}
              aria-pressed={explorerOpen}
              onClick={onToggleExplorer}
              className={cn(
                "size-6",
                explorerOpen ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <PanelLeft className="size-3.5" />
            </Button>
          </IconAction>
        )}
      </div>

      <UnstyledButton
        onClick={onQuickOpen}
        aria-label="Open a policy file"
        className="group order-last flex h-6 w-full min-w-0 items-center gap-2 rounded-md border sm:order-none sm:w-auto bg-background px-2 text-xs outline-none transition-colors hover:border-ring/60 hover:bg-accent/40 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <Search className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        {isSource ? (
          <>
            <KindIcon
              className={cn("size-3.5 shrink-0", kind.iconClass)}
              aria-hidden
            />
            <span className="min-w-0 truncate font-mono text-[12px]">
              {slash >= 0 && (
                <span className="text-muted-foreground">
                  {active.path.slice(0, slash + 1)}
                </span>
              )}
              <span className="text-foreground">
                {active.path.slice(slash + 1)}
              </span>
            </span>
            <span
              data-testid="policy-file-kind"
              className={cn(
                "shrink-0 rounded-sm border px-1 text-[10px] font-medium leading-4",
                kind.chipClass,
              )}
            >
              {active.mcpServerRules ? "MCP server rules" : kind.label}
            </span>
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
        ) : (
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
        )}
        <span className="ml-auto hidden shrink-0 items-center gap-0.5 opacity-70 group-hover:opacity-100 sm:flex">
          <Kbd className="h-4 min-w-4 px-1">{isMac ? "⌘" : "Ctrl"}</Kbd>
          <Kbd className="h-4 min-w-4 px-1">P</Kbd>
        </span>
      </UnstyledButton>

      <div className="flex w-full items-center justify-end gap-0.5 sm:w-auto">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="img"
              aria-label={readOnly}
              className="flex size-6 items-center justify-center text-muted-foreground"
            >
              <LockKeyhole className="size-3.5" aria-hidden />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{readOnly}</TooltipContent>
        </Tooltip>
        {workspace.managed &&
          (workspace.repositoryUrl ? (
            <IconLink href={workspace.repositoryUrl} label={managedIn}>
              <GitBranch className="size-3.5" />
            </IconLink>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  role="img"
                  aria-label={managedIn}
                  className="flex size-6 items-center justify-center text-muted-foreground"
                >
                  <GitBranch className="size-3.5" aria-hidden />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">{managedIn}</TooltipContent>
            </Tooltip>
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
        {workspace.canChangeInChat && (
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
        {isSource && (
          <IconAction
            label={outlineOpen ? "Hide rule outline" : "Show rule outline"}
            className="hidden lg:inline-flex"
          >
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={
                outlineOpen ? "Hide rule outline" : "Show rule outline"
              }
              aria-pressed={outlineOpen}
              onClick={onToggleOutline}
              className={cn(
                "size-6",
                outlineOpen ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <PanelRight className="size-3.5" />
            </Button>
          </IconAction>
        )}
      </div>
    </div>
  );
}

/** An icon that opens a page in a new tab, named by its tooltip. */
function IconLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <IconAction label={label}>
      <Button
        asChild
        variant="ghost"
        size="icon-xs"
        className="size-6 text-muted-foreground hover:text-foreground"
      >
        <a
          href={href}
          aria-label={label}
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      </Button>
    </IconAction>
  );
}

function IconAction({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex", className)}>{children}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** Whether a side panel is open, remembered across visits; open by default. */
function useStoredFlag(key: string) {
  const [value, setValue] = useState(true);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(key) === "0") setValue(false);
    } catch {
      // Storage is unavailable: the default stands.
    }
  }, [key]);
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // Storage is unavailable: the choice lasts for this visit.
      }
    },
    [key],
  );
  return [value, set] as const;
}

function useIsMac() {
  const [isMac, setIsMac] = useState(true);
  useEffect(() => {
    setIsMac(/mac|iphone|ipad/i.test(window.navigator.userAgent));
  }, []);
  return isMac;
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
