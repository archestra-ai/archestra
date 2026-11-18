"use client";

import {
  ChevronRight,
  Folder,
  FolderOpen,
  Loader2,
  LockKeyhole,
  Play,
  Plus,
  TriangleAlert,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";
import { batteriesHref } from "./battery-status";
import { useOpenAppaChatLaunch } from "./openappa-chat-button";
import {
  INCLUDED_FILES_HINT,
  POLICY_FILE_KIND,
  POLICY_FILE_KINDS,
  PolicyStatusDot,
  policyFileIcon,
} from "./policy-file-kind";
import {
  buildPolicyTree,
  type PolicyFile,
  type PolicyTreeNode,
} from "./policy-files";
import { VALIDATION_STATUS_LOOK } from "./policy-validation-pane";
import type { PolicyWorkspace } from "./use-policy-workspace";

/**
 * The policy's files as an IDE explorer: one section per kind, so the
 * organization policy, the batteries and the repository's files never read
 * as one another, with the files' real folders inside.
 */
export function PolicyExplorer({
  workspace,
  overlay = false,
}: {
  workspace: PolicyWorkspace;
  /** Fills a panel laid over the editor on a small screen, where the column beside it has no room. */
  overlay?: boolean;
}) {
  // A validation is written by the policy agent: New validation opens the
  // chat on that request.
  const newValidation = useOpenAppaChatLaunch({
    subject: { kind: "prompt", promptKey: "writeValidations" },
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const sections = useMemo(
    () =>
      POLICY_FILE_KINDS.flatMap((kind) => {
        const files = workspace.files.filter((file) => file.kind === kind);
        // The validations keep their section while it is empty: it is where
        // the first one is added.
        return files.length === 0 &&
          !(kind === "validation" && workspace.validations)
          ? []
          : [
              {
                kind,
                files,
                count: files.length,
                nodes: buildPolicyTree(files),
              },
            ];
      }),
    [workspace.files, workspace.validations],
  );
  const suite = workspace.validations;
  const activeKey = workspace.view === "source" ? workspace.active.key : null;

  return (
    <nav
      aria-label="Policy files"
      className={cn(
        "flex-col overflow-y-auto pb-2",
        overlay
          ? "flex min-h-0 flex-1"
          : "hidden w-60 shrink-0 border-r bg-muted/20 md:flex",
      )}
    >
      {sections.map((section) => {
        const sectionKey = `section:${section.kind}`;
        const open = !collapsed.has(sectionKey);
        const { attentionCount } = workspace;
        return (
          <div key={section.kind} className="flex flex-col">
            <div className="sticky top-0 z-10 flex h-6 items-center gap-1 border-b bg-muted pr-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
              <UnstyledButton
                aria-expanded={open}
                onClick={() => toggle(sectionKey)}
                className="flex h-full min-w-0 flex-1 items-center gap-1 pl-1.5 text-left uppercase outline-none hover:text-foreground focus-visible:text-foreground"
              >
                <ChevronRight
                  className={cn(
                    "size-3 shrink-0 transition-transform",
                    open && "rotate-90",
                  )}
                  aria-hidden
                />
                <span
                  className="truncate"
                  title={
                    section.kind === "repository" && !workspace.scoped
                      ? INCLUDED_FILES_HINT
                      : undefined
                  }
                >
                  {workspace.scoped
                    ? "MCP server rules"
                    : POLICY_FILE_KIND[section.kind].section}
                </span>
                {section.kind !== "root" && (
                  <span className="ml-auto font-mono font-normal tabular-nums">
                    {section.count}
                  </span>
                )}
              </UnstyledButton>
              {section.kind === "validation" && suite && (
                <ValidationSectionActions
                  failed={
                    section.files.filter(
                      (file) => file.validation?.status === "failed",
                    ).length
                  }
                  cannotRun={
                    section.files.filter(
                      (file) => file.validation?.status === "cannot_run",
                    ).length
                  }
                  running={suite.runningAll}
                  canRun={suite.runnable && section.count > 0}
                  onRunAll={() => suite.runAll()}
                  newHref={suite.canWrite ? (newValidation.href ?? null) : null}
                />
              )}
              {section.kind === "battery" && attentionCount > 0 && (
                // Every included battery with a problem is in the Needs attention group.
                <Link
                  href={batteriesHref("attention")}
                  aria-label={`${attentionCount} not enforced`}
                  title={`${attentionCount} not enforced`}
                  className="flex items-center gap-0.5 rounded-sm bg-amber-500/15 px-1 font-mono font-medium normal-case tracking-normal text-amber-700 underline-offset-2 hover:underline dark:text-amber-400"
                >
                  <TriangleAlert className="size-2.5" aria-hidden />
                  <span>{attentionCount}</span>
                </Link>
              )}
            </div>
            {open && section.count === 0 && (
              <p className="px-3 py-2 text-[11.5px] leading-4 text-muted-foreground">
                No validations yet. A validation replays tool calls against the
                policy and checks each decision.
              </p>
            )}
            {open && section.count > 0 && (
              <div className="py-0.5">
                <TreeNodes
                  nodes={section.nodes}
                  depth={0}
                  scope={section.kind}
                  collapsed={collapsed}
                  onToggle={toggle}
                  activeKey={activeKey}
                  onOpen={workspace.open}
                />
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

function TreeNodes({
  nodes,
  depth,
  scope,
  collapsed,
  onToggle,
  activeKey,
  onOpen,
}: {
  nodes: PolicyTreeNode[];
  depth: number;
  scope: string;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  activeKey: string | null;
  onOpen: (entry: string | null) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const paddingLeft = 6 + depth * 12;
        if (node.type === "dir") {
          const key = `${scope}:${node.path}`;
          const open = !collapsed.has(key);
          const DirIcon = open ? FolderOpen : Folder;
          return (
            <div key={key}>
              <UnstyledButton
                aria-expanded={open}
                onClick={() => onToggle(key)}
                style={{ paddingLeft }}
                className={ROW_CLASS}
              >
                <ChevronRight
                  className={cn(
                    "size-3 shrink-0 text-muted-foreground transition-transform",
                    open && "rotate-90",
                  )}
                  aria-hidden
                />
                <DirIcon
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span className="truncate">{node.name}</span>
              </UnstyledButton>
              {open && (
                <TreeNodes
                  nodes={node.children}
                  depth={depth + 1}
                  scope={scope}
                  collapsed={collapsed}
                  onToggle={onToggle}
                  activeKey={activeKey}
                  onOpen={onOpen}
                />
              )}
            </div>
          );
        }
        const { file } = node;
        const isActive = file.key === activeKey;
        const Icon = policyFileIcon(file);
        const row = (
          <UnstyledButton
            key={file.key}
            aria-current={isActive ? "page" : undefined}
            aria-disabled={file.disabled || undefined}
            onClick={() => {
              if (!file.disabled) onOpen(file.entry);
            }}
            // 16px: the chevron and its gap, so files align with folder names.
            style={{ paddingLeft: paddingLeft + 16 }}
            className={cn(
              ROW_CLASS,
              "relative gap-1.5",
              isActive &&
                "bg-accent font-medium text-accent-foreground before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary",
              file.disabled &&
                "cursor-not-allowed text-muted-foreground/70 hover:bg-transparent",
            )}
          >
            <Icon
              className={cn(
                "size-3.5 shrink-0",
                file.disabled
                  ? "text-muted-foreground/60"
                  : POLICY_FILE_KIND[file.kind].iconClass,
              )}
              aria-hidden
            />
            <span className={cn("truncate", file.disabled && "line-through")}>
              {file.name}
            </span>
            {file.severity && (
              <>
                <PolicyStatusDot severity={file.severity} className="ml-auto" />
                <span className="sr-only">{file.statusLabel}</span>
              </>
            )}
            {file.validation && (
              <>
                <span
                  aria-hidden
                  className={cn(
                    "ml-auto size-1.5 shrink-0 rounded-full",
                    VALIDATION_STATUS_LOOK[file.validation.status].dot,
                  )}
                />
                <span className="sr-only">
                  {VALIDATION_STATUS_LOOK[file.validation.status].label}
                </span>
              </>
            )}
            {file.canEdit === false && (
              <>
                <LockKeyhole
                  className="ml-auto size-3 shrink-0 text-muted-foreground/70"
                  aria-hidden
                />
                <span className="sr-only">Read-only</span>
              </>
            )}
          </UnstyledButton>
        );
        // Every row has a tooltip, so a row keeps its element when the
        // sync settings arrive and turn a file into an MCP server's rules.
        return (
          <Tooltip key={file.key}>
            <TooltipTrigger asChild>{row}</TooltipTrigger>
            <TooltipContent side="right">
              {file.kind === "root" ? (
                <span>Organization policy</span>
              ) : file.kind === "battery" ? (
                <span className="flex items-center gap-1.5">
                  <span className="font-medium">{file.label}</span>
                  <span>{file.statusLabel}</span>
                </span>
              ) : file.validation ? (
                <span className="flex items-center gap-1.5">
                  <span className="font-medium">{file.validation.title}</span>
                  <span>
                    {VALIDATION_STATUS_LOOK[file.validation.status].label}
                  </span>
                </span>
              ) : (
                <span>{repositoryFileTip(file)}</span>
              )}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </>
  );
}

const ROW_CLASS =
  "flex h-[26px] w-full items-center gap-1 pr-2 text-left text-[12.5px] text-foreground/80 outline-none hover:bg-accent/60 focus-visible:bg-accent/60";

/** What the validations add to their section's header: how they stand, run all, new. */
function ValidationSectionActions({
  failed,
  cannotRun,
  running,
  canRun,
  onRunAll,
  newHref,
}: {
  failed: number;
  cannotRun: number;
  running: boolean;
  canRun: boolean;
  onRunAll: () => void;
  /** The chat, opened on a request for a new validation; null when it cannot be asked. */
  newHref: string | null;
}) {
  const button =
    "flex size-4 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50";
  return (
    <>
      {!running && failed > 0 && (
        <span
          title={`${failed} failed`}
          className="flex items-center gap-0.5 rounded-sm bg-destructive/10 px-1 font-mono font-medium normal-case tracking-normal text-destructive"
        >
          <X className="size-2.5" aria-hidden />
          <span>{failed}</span>
          <span className="sr-only">failed</span>
        </span>
      )}
      {!running && cannotRun > 0 && (
        <span
          title={`${cannotRun} cannot run`}
          className="flex items-center gap-0.5 rounded-sm bg-amber-500/15 px-1 font-mono font-medium normal-case tracking-normal text-amber-700 dark:text-amber-400"
        >
          <TriangleAlert className="size-2.5" aria-hidden />
          <span>{cannotRun}</span>
          <span className="sr-only">cannot run</span>
        </span>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <UnstyledButton
            aria-label="Run all validations"
            disabled={!canRun}
            onClick={onRunAll}
            className={button}
          >
            {running ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : (
              <Play className="size-3" aria-hidden />
            )}
          </UnstyledButton>
        </TooltipTrigger>
        <TooltipContent side="right">Run all validations</TooltipContent>
      </Tooltip>
      {newHref && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link href={newHref} aria-label="New validation" className={button}>
              <Plus className="size-3" aria-hidden />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-48">
            New validation: ask the policy agent in chat
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
}

function repositoryFileTip(file: PolicyFile): string {
  if (!file.mcpServerRules) return "Included from your repository";
  const servers = (file.servers ?? []).map((server) => server.name).join(", ");
  return `MCP server rules${servers ? `: ${servers}` : ""}${
    file.canEdit === false ? " · read-only" : ""
  }`;
}
