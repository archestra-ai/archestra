"use client";

import {
  ChevronRight,
  Folder,
  FolderOpen,
  LockKeyhole,
  TriangleAlert,
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
import {
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
import type { PolicyWorkspace } from "./use-policy-workspace";

/**
 * The policy's files as an IDE explorer: one section per kind, so the
 * organization policy, the batteries and the repository's files never read
 * as one another, with the files' real folders inside.
 */
export function PolicyExplorer({ workspace }: { workspace: PolicyWorkspace }) {
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
        return files.length === 0
          ? []
          : [{ kind, count: files.length, nodes: buildPolicyTree(files) }];
      }),
    [workspace.files],
  );
  const activeKey = workspace.view === "source" ? workspace.active.key : null;

  return (
    <nav
      aria-label="Policy files"
      className="hidden w-60 shrink-0 flex-col overflow-y-auto border-r bg-muted/20 pb-2 md:flex"
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
                <span className="truncate">
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
            {open && (
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

function repositoryFileTip(file: PolicyFile): string {
  if (!file.mcpServerRules) return "Repository file";
  const servers = (file.servers ?? []).map((server) => server.name).join(", ");
  return `MCP server rules${servers ? `: ${servers}` : ""}${
    file.canEdit === false ? " · read-only" : ""
  }`;
}
