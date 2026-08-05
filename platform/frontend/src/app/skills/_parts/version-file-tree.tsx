"use client";

import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
} from "lucide-react";
import {
  groupFilesByFolder,
  type SkillFileChange,
} from "@/lib/skills/skill-version-diff";
import { cn } from "@/lib/utils";

/**
 * One row of the version's file tree. `path` is null for SKILL.md, which is not
 * a resource file but reads as one here.
 */
export interface VersionEntry {
  path: string | null;
  change: SkillFileChange | null;
}

/**
 * The version's files as the skill editor draws them — SKILL.md pinned on top,
 * then one level of folders, then loose files — annotated with what changed.
 */
export function VersionFileTree({
  entries,
  activePath,
  collapsedFolders,
  onToggleFolder,
  onSelect,
}: {
  entries: VersionEntry[];
  activePath: string | null;
  collapsedFolders: Set<string>;
  onToggleFolder: (folder: string) => void;
  onSelect: (path: string | null) => void;
}) {
  const manifest = entries.find((entry) => entry.path === null) ?? null;
  const fileEntries = entries.filter(
    (entry): entry is VersionEntry & { path: string } => entry.path !== null,
  );

  return (
    <ul className="space-y-0.5">
      {manifest ? (
        <VersionFileRow
          label={SKILL_MANIFEST_LABEL}
          change={manifest.change}
          isActive={activePath === null}
          isManifest
          onSelect={() => onSelect(null)}
        />
      ) : null}

      {groupFilesByFolder(fileEntries).map(({ folder, files }) => {
        if (folder === null) {
          return files.map((entry) => (
            <VersionFileRow
              key={entry.path}
              label={entry.path}
              change={entry.change}
              isActive={activePath === entry.path}
              onSelect={() => onSelect(entry.path)}
            />
          ));
        }
        const isCollapsed = collapsedFolders.has(folder);
        return (
          <li key={folder}>
            <FolderRow
              folder={folder}
              fileCount={files.length}
              isCollapsed={isCollapsed}
              onToggle={() => onToggleFolder(folder)}
            />
            {isCollapsed ? null : (
              <ul className="ml-5 space-y-0.5 border-l pl-2">
                {files.map((entry) => (
                  <VersionFileRow
                    key={entry.path}
                    label={entry.path.slice(folder.length + 1)}
                    change={entry.change}
                    isActive={activePath === entry.path}
                    onSelect={() => onSelect(entry.path)}
                  />
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** SKILL.md is not a resource file, but the tree lists it like one. */
const SKILL_MANIFEST_LABEL = "SKILL.md";

function FolderRow({
  folder,
  fileCount,
  isCollapsed,
  onToggle,
}: {
  folder: string;
  fileCount: number;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full cursor-pointer items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-muted/50"
      onClick={onToggle}
    >
      {isCollapsed ? (
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      {isCollapsed ? (
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <span className="text-sm font-medium">{folder}/</span>
      {isCollapsed ? (
        <span className="text-xs text-muted-foreground">({fileCount})</span>
      ) : null}
    </button>
  );
}

function VersionFileRow({
  label,
  change,
  isActive,
  isManifest,
  onSelect,
}: {
  label: string;
  change: SkillFileChange | null;
  isActive: boolean;
  isManifest?: boolean;
  onSelect: () => void;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-2 rounded px-2 py-1",
        isActive ? "bg-muted" : "hover:bg-muted/50",
      )}
    >
      <FileText
        className={cn(
          "h-4 w-4 shrink-0",
          isManifest ? "text-foreground" : "text-muted-foreground",
        )}
      />
      <button
        type="button"
        aria-current={isActive ? "true" : undefined}
        className={cn(
          "flex-1 cursor-pointer truncate text-left font-mono text-xs",
          isManifest && "font-medium",
        )}
        onClick={onSelect}
      >
        {label}
      </button>
      {/* `unchanged` and a null change both go unbadged, for opposite reasons:
          one is a comparison that found nothing, the other is no comparison at
          all. Nothing above the tree claims otherwise in either case. */}
      {change === null || change === "unchanged" ? null : (
        <span
          className={cn(
            "shrink-0 text-[10px] font-semibold uppercase",
            change === "added" && "text-emerald-600 dark:text-emerald-400",
            change === "removed" && "text-destructive",
            change === "changed" && "text-muted-foreground",
          )}
        >
          {change}
        </span>
      )}
    </li>
  );
}
