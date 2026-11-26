"use client";

import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";
import {
  buildFileTree,
  type FileTreeNode,
  type WorkspaceFile,
} from "./file-tree";

/** One collapsible group of the explorer, such as "Batteries" or "Files". */
export interface FileExplorerSection<F extends WorkspaceFile> {
  id: string;
  title: string;
  /** What the section holds, for whoever hovers its title. */
  titleHint?: string;
  /** Shown at the end of the header; left out, no count is shown. */
  count?: number;
  /** Controls beside the header's title, such as "New file". */
  actions?: ReactNode;
  files: F[];
  /** Lists the files by full path, with no folders. */
  flat?: boolean;
  /** Shown in place of the files while there are none. */
  empty?: ReactNode;
  /**
   * A row put first inside a folder (its path) or the section (null), at
   * that depth, such as a file name being typed.
   */
  insertRow?: (folder: string | null, depth: number) => ReactNode;
}

/**
 * Files as an IDE explorer: a sticky header per section, the files' real
 * folders inside, compact 26px rows. What a row shows beyond its name — an
 * icon, a status, a tooltip, hover actions — is the caller's.
 */
export function FileExplorer<F extends WorkspaceFile>({
  label,
  sections,
  activeKey,
  onOpen,
  fileIcon,
  fileTrailing,
  fileTooltip,
  fileActions,
  folderActions,
  actionsAlwaysShown = false,
  overlay = false,
}: {
  /** The accessible name of the explorer's navigation landmark. */
  label: string;
  sections: FileExplorerSection<F>[];
  activeKey: string | null;
  onOpen: (file: F) => void;
  fileIcon: (file: F) => ReactNode;
  /** Inside the row, after the name: part of the row's accessible name. */
  fileTrailing?: (file: F) => ReactNode;
  fileTooltip?: (file: F) => ReactNode;
  /** Buttons revealed on hover beside a file. */
  fileActions?: (file: F) => ReactNode;
  /** Buttons revealed on hover beside a folder (its path). */
  folderActions?: (folder: string) => ReactNode;
  /**
   * Shows the row buttons at all times, not only on hover: for an explorer
   * whose rows carry an action people come looking for, such as Delete.
   */
  actionsAlwaysShown?: boolean;
  /** Fills a panel laid over the editor on a small screen. */
  overlay?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const trees = useMemo(
    () =>
      sections.map((section) =>
        section.flat
          ? section.files.map(
              (file): FileTreeNode<F> => ({
                type: "file",
                name: file.path,
                path: file.path,
                file,
              }),
            )
          : buildFileTree(section.files),
      ),
    [sections],
  );
  const row: RowRenderers<F> = {
    activeKey,
    onOpen,
    fileIcon,
    fileTrailing,
    fileTooltip,
    fileActions,
    folderActions,
    actionsAlwaysShown,
  };

  return (
    <nav
      aria-label={label}
      className={cn(
        "flex-col overflow-y-auto pb-2",
        overlay
          ? "flex min-h-0 flex-1"
          : "hidden w-60 shrink-0 border-r bg-muted/20 md:flex",
      )}
    >
      {sections.map((section, index) => {
        const sectionKey = `section:${section.id}`;
        const open = !collapsed.has(sectionKey);
        const nodes = trees[index];
        const insert = section.insertRow?.(null, 0);
        return (
          <div key={section.id} className="flex flex-col">
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
                <span className="truncate" title={section.titleHint}>
                  {section.title}
                </span>
                {section.count !== undefined && (
                  <span className="ml-auto font-mono font-normal tabular-nums">
                    {section.count}
                  </span>
                )}
              </UnstyledButton>
              {section.actions}
            </div>
            {open && nodes.length === 0 && !insert && section.empty && (
              <div className="px-3 py-2 text-[11.5px] leading-4 text-muted-foreground">
                {section.empty}
              </div>
            )}
            {open && (nodes.length > 0 || insert) && (
              <div className="py-0.5">
                {insert}
                <TreeNodes
                  nodes={nodes}
                  depth={0}
                  scope={section.id}
                  collapsed={collapsed}
                  onToggle={toggle}
                  insertRow={section.insertRow}
                  row={row}
                />
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

/** Left padding of a row at a depth, for a row a caller adds to the tree. */
export function fileRowIndent(depth: number): number {
  return 6 + depth * 12 + 16;
}

/** The look of an explorer row, for a row a caller adds to the tree. */
export const FILE_ROW_CLASS =
  "flex h-[26px] w-full items-center gap-1 pr-2 text-left text-[12.5px] text-foreground/80 outline-none hover:bg-accent/60 focus-visible:bg-accent/60";

/** A hover action beside an explorer row or in a section header. */
export const FILE_ROW_ACTION_CLASS =
  "flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50";

// ============================================================================
// Internal helpers
// ============================================================================

interface RowRenderers<F extends WorkspaceFile> {
  activeKey: string | null;
  onOpen: (file: F) => void;
  fileIcon: (file: F) => ReactNode;
  fileTrailing?: (file: F) => ReactNode;
  fileTooltip?: (file: F) => ReactNode;
  fileActions?: (file: F) => ReactNode;
  folderActions?: (folder: string) => ReactNode;
  actionsAlwaysShown: boolean;
}

function TreeNodes<F extends WorkspaceFile>({
  nodes,
  depth,
  scope,
  collapsed,
  onToggle,
  insertRow,
  row,
}: {
  nodes: FileTreeNode<F>[];
  depth: number;
  scope: string;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  insertRow?: (folder: string | null, depth: number) => ReactNode;
  row: RowRenderers<F>;
}) {
  return (
    <>
      {nodes.map((node) => {
        const paddingLeft = 6 + depth * 12;
        if (node.type === "dir") {
          const key = `${scope}:${node.path}`;
          const open = !collapsed.has(key);
          const DirIcon = open ? FolderOpen : Folder;
          const actions = row.folderActions?.(node.path);
          return (
            <div key={key}>
              <RowFrame actions={actions} alwaysShown={row.actionsAlwaysShown}>
                <UnstyledButton
                  aria-expanded={open}
                  onClick={() => onToggle(key)}
                  style={{ paddingLeft }}
                  className={FILE_ROW_CLASS}
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
              </RowFrame>
              {open && (
                <>
                  {insertRow?.(node.path, depth + 1)}
                  <TreeNodes
                    nodes={node.children}
                    depth={depth + 1}
                    scope={scope}
                    collapsed={collapsed}
                    onToggle={onToggle}
                    insertRow={insertRow}
                    row={row}
                  />
                </>
              )}
            </div>
          );
        }
        const { file } = node;
        const isActive = file.key === row.activeKey;
        const button = (
          <UnstyledButton
            aria-current={isActive ? "page" : undefined}
            aria-disabled={file.disabled || undefined}
            onClick={() => {
              if (!file.disabled) row.onOpen(file);
            }}
            // 16px: the chevron and its gap, so files align with folder names.
            style={{ paddingLeft: paddingLeft + 16 }}
            className={cn(
              FILE_ROW_CLASS,
              "relative gap-1.5",
              isActive &&
                "bg-accent font-medium text-accent-foreground before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary",
              file.disabled &&
                "cursor-not-allowed text-muted-foreground/70 hover:bg-transparent",
            )}
          >
            {row.fileIcon(file)}
            <span className={cn("truncate", file.disabled && "line-through")}>
              {node.name}
            </span>
            {row.fileTrailing?.(file)}
          </UnstyledButton>
        );
        const tooltip = row.fileTooltip?.(file);
        return (
          <RowFrame
            key={file.key}
            actions={row.fileActions?.(file)}
            alwaysShown={row.actionsAlwaysShown}
          >
            {tooltip ? (
              <Tooltip>
                <TooltipTrigger asChild>{button}</TooltipTrigger>
                <TooltipContent side="right">{tooltip}</TooltipContent>
              </Tooltip>
            ) : (
              button
            )}
          </RowFrame>
        );
      })}
    </>
  );
}

/** A row with its hover actions beside it, not inside its button. */
function RowFrame({
  actions,
  alwaysShown,
  children,
}: {
  actions?: ReactNode;
  alwaysShown: boolean;
  children: ReactNode;
}) {
  if (!actions) return <>{children}</>;
  return (
    <div className="group/row relative">
      {children}
      <div
        className={cn(
          "absolute inset-y-0 right-1 flex items-center gap-0.5",
          !alwaysShown &&
            "opacity-100 md:opacity-0 md:group-focus-within/row:opacity-100 md:group-hover/row:opacity-100",
        )}
      >
        {actions}
      </div>
    </div>
  );
}
