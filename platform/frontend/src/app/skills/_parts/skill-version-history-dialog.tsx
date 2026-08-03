"use client";

import { format } from "date-fns";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  RotateCcw,
} from "lucide-react";
import { useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DiffEditor } from "@/components/diff-editor";
import { Editor } from "@/components/editor";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { PermissionButton } from "@/components/ui/permission-button";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  type SkillVersionDetail,
  type SkillVersionSummary,
  useResetSkill,
  useRestoreSkillVersion,
  useSkill,
  useSkillVersion,
  useSkillVersions,
} from "@/lib/skills/skill.query";
import { cn } from "@/lib/utils";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import {
  type ComparedSkillFile,
  compareSkillVersionFiles,
  groupFilesByFolder,
  type SkillFileChange,
} from "./skill-version-diff";

/** Whether the right pane shows only what moved, or the whole version. */
type VersionViewMode = "changes" | "all";

/** SKILL.md is not a resource file, but the tree lists it like one. */
const SKILL_MANIFEST_LABEL = "SKILL.md";

/**
 * Browse a skill's immutable version history and restore an earlier one.
 *
 * A version captures the skill's instructions and resource files, and nothing
 * else: frontmatter fields live in their own columns and are not versioned, so
 * neither the history nor a restore says anything about them.
 *
 * Restoring forks forward — the old bytes become a new head version — so the
 * history is only ever appended to, and a sandbox that pinned a version keeps
 * replaying the bytes it was activated with.
 */
export function SkillVersionHistoryDialog(props: {
  skillId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Remounting per skill drops the previewed version and file selection, which
  // belong to the skill they were chosen for and mean nothing for another one.
  return <VersionHistory key={props.skillId} {...props} />;
}

function VersionHistory({
  skillId,
  open,
  onOpenChange,
}: {
  skillId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const appName = useAppName();
  const { data: skill, isPending: isSkillLoading } = useSkill(
    open ? skillId : null,
  );
  const versionsQuery = useSkillVersions(open ? skillId : null);
  const restoreVersion = useRestoreSkillVersion();
  const resetSkill = useResetSkill();

  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  // null = SKILL.md is open; otherwise a resource file path.
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  // Survives version selection: whoever came to read diffs keeps reading diffs.
  const [viewMode, setViewMode] = useState<VersionViewMode>("changes");
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const versions = useMemo(
    () => versionsQuery.data?.pages.flatMap((page) => page?.data ?? []) ?? [],
    [versionsQuery.data],
  );
  const headVersion = skill?.latestVersion ?? versions[0]?.version ?? null;
  const activeVersion = selectedVersion ?? headVersion;
  const isHead = activeVersion !== null && activeVersion === headVersion;
  const headContentHash = versions.find(
    (version) => version.version === headVersion,
  )?.contentHash;

  const { data: detail, isPending: isDetailLoading } = useSkillVersion(
    open ? skillId : null,
    activeVersion,
  );
  // Versions are contiguous from 1, so the diff baseline is simply the previous
  // number; version 1 has none and renders as an all-new document.
  const hasPredecessor = activeVersion !== null && activeVersion > 1;
  const { data: predecessor } = useSkillVersion(
    open ? skillId : null,
    hasPredecessor ? (activeVersion as number) - 1 : null,
  );

  // The oldest version compares against nothing, so its whole file set reads as
  // added. Waiting for a predecessor that will never arrive would leave it
  // looking permanently empty.
  const isBaselineReady = detail && (predecessor || !hasPredecessor);
  const comparedFiles = useMemo(
    () =>
      isBaselineReady
        ? compareSkillVersionFiles(detail.files, predecessor?.files ?? [])
        : [],
    [detail, predecessor, isBaselineReady],
  );

  const isSynced = !!skill?.githubSyncInterval;
  const isBuiltIn = skill?.sourceType === "built_in";
  const canRestore =
    !!detail && !!skill && !isHead && !isSynced && !!headContentHash;

  const handleRestore = async () => {
    if (!skill || !detail || !headContentHash || activeVersion === null) return;
    const result = await restoreVersion.mutateAsync({
      skillId: skill.id,
      version: activeVersion,
      expectedHeadVersion: skill.latestVersion,
      headContentHash,
    });
    setConfirmingRestore(false);
    // A restore lands as the new head, so the previewed version is no longer
    // what the skill looks like — jump the selection to the version just made.
    if (result) setSelectedVersion(result.latestVersion);
  };

  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Version history"
      description={
        skill
          ? `Every edit to "${skill.name}" is kept as a version. Restoring one adds a new version.`
          : "Every edit is kept as a version."
      }
      size="large"
      bodyClassName="flex flex-col overflow-hidden p-0"
      footer={
        <div className="flex w-full items-center gap-3">
          {isBuiltIn ? (
            <PermissionButton
              permissions={{ skill: ["update"] }}
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setConfirmingReset(true)}
              disabled={resetSkill.isPending}
            >
              <RotateCcw className="h-4 w-4" />
              <span>Reset to default</span>
            </PermissionButton>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
            <PermissionButton
              permissions={{ skill: ["update"] }}
              disabled={!canRestore || restoreVersion.isPending}
              onClick={() => setConfirmingRestore(true)}
              tooltip={restoreTooltip({ isSynced, isHead, appName })}
            >
              {restoreVersion.isPending
                ? "Restoring..."
                : "Restore this version"}
            </PermissionButton>
          </div>
        </div>
      }
    >
      {isSynced ? (
        <p className="border-b bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
          This skill&apos;s content is synced from GitHub. Earlier versions stay
          viewable, but restoring one is unavailable — stop syncing the skill in
          its editor to make it editable in {appName}.
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Versions"
          className="w-64 shrink-0 overflow-y-auto border-r py-2"
        >
          <VersionTimeline
            versions={versions}
            headVersion={headVersion}
            activeVersion={activeVersion}
            isLoading={versionsQuery.isPending || isSkillLoading}
            hasMore={!!versionsQuery.hasNextPage}
            isLoadingMore={versionsQuery.isFetchingNextPage}
            onLoadMore={() => versionsQuery.fetchNextPage()}
            onSelect={(version) => {
              setSelectedVersion(version);
              setActiveFilePath(null);
            }}
          />
        </nav>

        <section className="flex min-w-0 flex-1 flex-col">
          {activeVersion === null ? (
            <p className="p-6 text-sm text-muted-foreground">
              This skill has no recorded versions yet.
            </p>
          ) : (
            <VersionPreview
              version={activeVersion}
              isHead={isHead}
              detail={detail ?? null}
              predecessor={predecessor ?? null}
              hasPredecessor={hasPredecessor}
              isBaselineReady={!!isBaselineReady}
              isLoading={isDetailLoading}
              comparedFiles={comparedFiles}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              activeFilePath={activeFilePath}
              onSelectFile={setActiveFilePath}
            />
          )}
        </section>
      </div>

      {skill && detail && activeVersion !== null ? (
        <DeleteConfirmDialog
          open={confirmingRestore}
          onOpenChange={setConfirmingRestore}
          title={`Restore version ${activeVersion}?`}
          description={
            <RestoreEffects
              version={activeVersion}
              nextVersion={skill.latestVersion + 1}
              fileCount={detail.files.length}
            />
          }
          isPending={restoreVersion.isPending}
          onConfirm={handleRestore}
          confirmLabel={`Restore version ${activeVersion}`}
          pendingLabel="Restoring..."
        />
      ) : null}

      {skill ? (
        <DeleteConfirmDialog
          open={confirmingReset}
          onOpenChange={setConfirmingReset}
          title="Reset skill"
          description={`Reset "${skill.name}" to the version ${appName} ships? Any local edits to its instructions and resource files are overwritten, and the shipped content is recorded as a new version.`}
          isPending={resetSkill.isPending}
          onConfirm={async () => {
            const result = await resetSkill.mutateAsync(skill.id);
            if (result) {
              setConfirmingReset(false);
              setSelectedVersion(null);
            }
          }}
          confirmLabel="Reset to default"
          pendingLabel="Resetting..."
        />
      ) : null}
    </StandardDialog>
  );
}

function VersionTimeline({
  versions,
  headVersion,
  activeVersion,
  isLoading,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onSelect,
}: {
  versions: SkillVersionSummary[];
  headVersion: number | null;
  activeVersion: number | null;
  isLoading: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onSelect: (version: number) => void;
}) {
  if (isLoading && versions.length === 0) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        Loading versions...
      </p>
    );
  }
  if (versions.length === 0) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">No versions</p>
    );
  }

  return (
    <>
      {groupByDay(versions).map((group) => (
        <div key={group.label}>
          <h3 className="sticky top-0 bg-background px-4 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {group.label}
          </h3>
          {group.versions.map((version) => {
            const isActive = version.version === activeVersion;
            return (
              <button
                key={version.id}
                type="button"
                aria-current={isActive}
                onClick={() => onSelect(version.version)}
                className={cn(
                  "block w-full cursor-pointer border-l-2 border-transparent px-4 py-2 text-left hover:bg-muted",
                  isActive && "border-l-primary bg-accent",
                )}
              >
                {/* One line per version: the day heading already dates them,
                    and the selected version's own header carries the time. */}
                <span className="flex items-center gap-2">
                  <span className="font-mono text-xs font-medium">
                    v{version.version}
                  </span>
                  {version.version === headVersion ? (
                    <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                      Current
                    </Badge>
                  ) : null}
                  <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">
                    {version.contentHash.slice(0, 7)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ))}
      {hasMore ? (
        <div className="px-4 pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            disabled={isLoadingMore}
            onClick={onLoadMore}
          >
            {isLoadingMore ? "Loading..." : "Load older versions"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/**
 * One row of the version's file tree. `path` is null for SKILL.md, which is not
 * a resource file but reads as one here.
 */
interface VersionEntry {
  path: string | null;
  change: SkillFileChange;
}

function VersionPreview({
  version,
  isHead,
  detail,
  predecessor,
  hasPredecessor,
  isBaselineReady,
  isLoading,
  comparedFiles,
  viewMode,
  onViewModeChange,
  activeFilePath,
  onSelectFile,
}: {
  version: number;
  isHead: boolean;
  detail: SkillVersionDetail | null;
  predecessor: SkillVersionDetail | null;
  hasPredecessor: boolean;
  isBaselineReady: boolean;
  isLoading: boolean;
  comparedFiles: ComparedSkillFile<SkillVersionDetail["files"][number]>[];
  viewMode: VersionViewMode;
  onViewModeChange: (mode: VersionViewMode) => void;
  activeFilePath: string | null;
  onSelectFile: (path: string | null) => void;
}) {
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    new Set(),
  );

  if (isLoading && !detail) {
    return (
      <p className="p-6 text-sm text-muted-foreground">Loading version...</p>
    );
  }
  if (!detail) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        This version is no longer available.
      </p>
    );
  }

  const changeByPath = new Map(
    comparedFiles.map((file) => [file.path, file.change]),
  );
  const manifestChange: SkillFileChange = !hasPredecessor
    ? "added"
    : predecessor && predecessor.content !== detail.content
      ? "changed"
      : "unchanged";
  const changedFiles = comparedFiles.filter(
    (file) => file.change !== "unchanged",
  );
  const changeCount =
    changedFiles.length + (manifestChange === "unchanged" ? 0 : 1);

  // "Changes" lists only what moved — an unchanged SKILL.md has no place in it.
  // "All files" is the whole version, annotated with what moved.
  const entries: VersionEntry[] =
    viewMode === "all"
      ? [
          { path: null, change: manifestChange },
          ...detail.files.map((file) => ({
            path: file.path,
            change: changeByPath.get(file.path) ?? "unchanged",
          })),
        ]
      : [
          ...(manifestChange === "unchanged"
            ? []
            : [{ path: null, change: manifestChange }]),
          ...changedFiles.map((file) => ({
            path: file.path,
            change: file.change,
          })),
        ];

  // The chosen path is a preference, not a guarantee: switching modes can hide
  // it (an unchanged file, or one this version removed), so fall back to the
  // first row rather than rendering an empty pane.
  const activeEntry =
    entries.find((entry) => entry.path === activeFilePath) ??
    entries[0] ??
    null;
  const activePath = activeEntry?.path ?? null;
  const isManifest = !!activeEntry && activePath === null;
  const compared = activePath
    ? (comparedFiles.find((file) => file.path === activePath) ?? null)
    : null;
  const currentSnapshot = activePath
    ? (detail.files.find((file) => file.path === activePath) ??
      compared?.current ??
      null)
    : null;
  const isBinary =
    currentSnapshot?.encoding === "base64" ||
    compared?.previous?.encoding === "base64";
  // Until the predecessor lands there is nothing to compare against, and an
  // empty change set would read as "nothing changed" rather than "not yet
  // known". Browsing the whole version needs no baseline, so it renders now.
  const isComparing = viewMode === "changes" && !isBaselineReady;

  return (
    <>
      <header className="flex items-baseline gap-2 px-4 pt-3">
        <h2 className="text-base font-semibold">Version {version}</h2>
        {isHead ? <Badge variant="outline">Current</Badge> : null}
        <span className="text-xs text-muted-foreground">
          {formatRelativeTimeFromNow(detail.createdAt)}
        </span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {detail.contentHash.slice(0, 7)}
        </span>
      </header>

      <div className="px-4 pt-2">
        <ButtonGroup>
          <Button
            type="button"
            size="sm"
            variant={viewMode === "all" ? "secondary" : "outline"}
            onClick={() => onViewModeChange("all")}
          >
            All files ({detail.files.length + 1})
          </Button>
          <Button
            type="button"
            size="sm"
            variant={viewMode === "changes" ? "secondary" : "outline"}
            onClick={() => onViewModeChange("changes")}
          >
            Changes ({changeCount})
          </Button>
        </ButtonGroup>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr] gap-3 p-4">
        <div className="min-h-0 overflow-y-auto rounded-md border p-2">
          {isComparing ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              Loading changes...
            </p>
          ) : entries.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              Nothing changed in this version.
            </p>
          ) : (
            <VersionFileTree
              entries={entries}
              activePath={activePath}
              collapsedFolders={collapsedFolders}
              onToggleFolder={(folder) =>
                setCollapsedFolders((current) => {
                  const next = new Set(current);
                  if (!next.delete(folder)) next.add(folder);
                  return next;
                })
              }
              onSelect={onSelectFile}
            />
          )}
        </div>

        <div className="min-h-0 overflow-hidden rounded-md border">
          {isComparing || !activeEntry ? (
            <p className="p-4 text-sm text-muted-foreground">
              Nothing to show here.
            </p>
          ) : isBinary ? (
            <p className="p-4 text-sm text-muted-foreground">
              This file is binary, so there is nothing to show here.
            </p>
          ) : viewMode === "changes" ? (
            <DiffEditor
              height="100%"
              language={languageForPath(activePath ?? SKILL_MANIFEST_LABEL)}
              original={
                isManifest
                  ? (predecessor?.content ?? "")
                  : (compared?.previous?.content ?? "")
              }
              modified={
                isManifest ? detail.content : (currentSnapshot?.content ?? "")
              }
            />
          ) : (
            <Editor
              height="100%"
              language={languageForPath(activePath ?? SKILL_MANIFEST_LABEL)}
              value={
                isManifest ? detail.content : (currentSnapshot?.content ?? "")
              }
              options={{
                readOnly: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
              }}
            />
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The version's files as the skill editor draws them — SKILL.md pinned on top,
 * then one level of folders, then loose files — annotated with what changed.
 */
function VersionFileTree({
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
  change: SkillFileChange;
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
        className={cn(
          "flex-1 cursor-pointer truncate text-left font-mono text-xs",
          isManifest && "font-medium",
        )}
        onClick={onSelect}
      >
        {label}
      </button>
      {change === "unchanged" ? null : (
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

function RestoreEffects({
  version,
  nextVersion,
  fileCount,
}: {
  version: number;
  nextVersion: number;
  fileCount: number;
}) {
  return (
    <span className="block space-y-2">
      <span className="block">
        This creates version {nextVersion} from version {version}&apos;s
        content. Nothing in the history is rewritten or removed.
      </span>
      <span className="block">
        It replaces the skill&apos;s instructions and its {fileCount} resource
        {fileCount === 1 ? " file" : " files"}. Everything else is left as it
        is: the name, description, and other frontmatter fields are not
        versioned, and neither are scope, teams, environments, or GitHub
        settings.
      </span>
    </span>
  );
}

function groupByDay(versions: SkillVersionSummary[]) {
  const groups: { label: string; versions: SkillVersionSummary[] }[] = [];
  for (const version of versions) {
    const label = format(new Date(version.createdAt), "MMM d, yyyy");
    const current = groups.at(-1);
    if (current?.label === label) {
      current.versions.push(version);
    } else {
      groups.push({ label, versions: [version] });
    }
  }
  return groups;
}

function restoreTooltip({
  isSynced,
  isHead,
  appName,
}: {
  isSynced: boolean;
  isHead: boolean;
  appName: string;
}): string | undefined {
  if (isSynced) {
    return `This skill is synced from GitHub. Stop syncing it to edit and restore it in ${appName}.`;
  }
  if (isHead) return "This is the skill's current version.";
  return undefined;
}

function languageForPath(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return LANGUAGES_BY_EXTENSION[extension] ?? "plaintext";
}

const LANGUAGES_BY_EXTENSION: Record<string, string> = {
  js: "javascript",
  json: "json",
  md: "markdown",
  py: "python",
  sh: "shell",
  ts: "typescript",
  txt: "plaintext",
  yaml: "yaml",
  yml: "yaml",
};
