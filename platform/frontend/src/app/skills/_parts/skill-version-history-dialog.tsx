"use client";

import { format } from "date-fns";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
} from "lucide-react";
import { useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DiffEditor } from "@/components/diff-editor";
import { Editor } from "@/components/editor";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PermissionButton } from "@/components/ui/permission-button";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  type SkillVersionDetail,
  type SkillVersionSummary,
  useRestoreSkillVersion,
  useSkill,
  useSkillVersion,
  useSkillVersions,
} from "@/lib/skills/skill.query";
import { cn } from "@/lib/utils";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import {
  compareSkillVersionFiles,
  groupFilesByFolder,
  type SkillFileChange,
} from "./skill-version-diff";

/**
 * The manifest row is deliberately not called "SKILL.md": a version stores the
 * body alone, so this is a different document from the SKILL.md the editor
 * writes, which carries the frontmatter on top. Naming both files the same
 * thing would say the editor lost an edit that was never versioned.
 */
const SKILL_MANIFEST_LABEL = "Instructions";
/** The body is markdown; the row's label no longer carries an extension to read. */
const SKILL_MANIFEST_LANGUAGE = "markdown";

type SkillVersionFile = SkillVersionDetail["files"][number];

/**
 * One file of the version being viewed, paired with the predecessor's copy when
 * there is one. `change` is null when there is no baseline — version 1, or a
 * predecessor that could not be read — since nothing about the row is then a
 * comparison, and calling it added would report a failed fetch as a fact about
 * the skill's history.
 */
interface VersionFile {
  path: string;
  change: SkillFileChange | null;
  current: SkillVersionFile | null;
  previous: SkillVersionFile | null;
}

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
  const {
    data: skill,
    isPending: isSkillLoading,
    refetch: refetchSkill,
  } = useSkill(open ? skillId : null);
  const versionsQuery = useSkillVersions(open ? skillId : null);
  const restoreVersion = useRestoreSkillVersion();

  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  // null = SKILL.md is open; otherwise a resource file path.
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [confirmingRestore, setConfirmingRestore] = useState(false);

  // Pages are read by offset from a list that grows at the head, so a version
  // created between two page loads shifts every row down and the next page
  // re-returns rows the previous one already held. Keyed by id, the second copy
  // is dropped instead of rendering the version twice under a duplicate key.
  const versions = useMemo(() => {
    const seen = new Set<string>();
    return (versionsQuery.data?.pages ?? []).flatMap((page) =>
      (page?.data ?? []).filter((version) => {
        if (seen.has(version.id)) return false;
        seen.add(version.id);
        return true;
      }),
    );
  }, [versionsQuery.data]);
  const headVersion = skill?.latestVersion ?? versions[0]?.version ?? null;
  const activeVersion = selectedVersion ?? headVersion;
  const isHead = activeVersion !== null && activeVersion === headVersion;

  const {
    data: detail,
    isPending: isDetailLoading,
    isError: isDetailUnavailable,
    refetch: refetchDetail,
  } = useSkillVersion(open ? skillId : null, activeVersion);
  // Versions are contiguous from 1, so the diff baseline is simply the previous
  // number. There is one rule for the rest: a version is compared against its
  // predecessor when that predecessor loads, and shown on its own when it does
  // not — whether because there is none (version 1) or because the read failed.
  const hasPredecessor = activeVersion !== null && activeVersion > 1;
  const predecessorQuery = useSkillVersion(
    open ? skillId : null,
    hasPredecessor ? (activeVersion as number) - 1 : null,
  );
  const predecessor = predecessorQuery.data ?? null;
  // Worth saying out loud only when a baseline was expected and did not arrive;
  // version 1 having no predecessor is not a failure to report.
  const baselineFailed = hasPredecessor && predecessorQuery.isError;

  const versionFiles = useMemo((): VersionFile[] => {
    if (!detail) return [];
    if (predecessor) {
      return compareSkillVersionFiles(detail.files, predecessor.files);
    }
    // No baseline, so the version is listed on its own — same path order the
    // comparison produces, and no row claims anything about what moved.
    return [...detail.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => ({
        path: file.path,
        change: null,
        current: file,
        previous: null,
      }));
  }, [detail, predecessor]);

  // What a restore would do to the skill *as it stands today* — a different
  // question from what this version changed, and the one a confirmation has to
  // answer. `files` is a full replacement, so anything the skill has now and
  // this version lacks is dropped.
  const filesDroppedByRestore = useMemo(() => {
    if (!skill || !detail) return 0;
    const restoredPaths = new Set(detail.files.map((file) => file.path));
    return skill.files.filter((file) => !restoredPaths.has(file.path)).length;
  }, [skill, detail]);

  const isSynced = !!skill?.githubSyncInterval;
  const canRestore = !!detail && !!skill && !isHead && !isSynced;

  const handleRestore = async () => {
    if (!skill || !detail || activeVersion === null) return;
    // A handled failure resolves to null and a transport failure rejects; both
    // keep the confirmation open, so the toast explaining why still has the
    // dialog it refers to on screen. A restore that wrote nothing because the
    // version was already current still settles, and closes.
    const result = await restoreVersion
      .mutateAsync({
        skillId: skill.id,
        version: activeVersion,
        baseVersion: skill.latestVersion,
      })
      .catch(() => null);
    if (!result) return;
    setConfirmingRestore(false);
    // A restore lands as the new head, so the previewed version is no longer
    // what the skill looks like — jump the selection to the version just made,
    // clearing the open file the way picking a version from the timeline does.
    // Without that, a path the new head does not carry would silently read as
    // the manifest instead of as a file that is no longer there.
    setSelectedVersion(result.latestVersion);
    setActiveFilePath(null);
  };

  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Version history"
      description={
        skill
          ? `Every change to "${skill.name}"'s instructions or files is kept as a version. Restoring one adds a new version.`
          : "Every change to a skill's instructions or files is kept as a version."
      }
      size="large"
      bodyClassName="flex flex-col overflow-hidden p-0"
      footer={
        <div className="flex w-full items-center justify-end gap-2">
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
            {restoreVersion.isPending ? "Restoring..." : "Restore this version"}
          </PermissionButton>
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
          className="w-48 shrink-0 overflow-y-auto border-r py-2"
        >
          <VersionTimeline
            versions={versions}
            headVersion={headVersion}
            activeVersion={activeVersion}
            isLoading={versionsQuery.isPending || isSkillLoading}
            isError={versionsQuery.isError}
            onRetry={() => versionsQuery.refetch()}
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
          {/* Every skill has at least version 1, so there is no version to show
              only while the reads are in flight or after one of them failed.
              Saying the skill has no history would state something that is
              never true of a live skill. */}
          {activeVersion === null ? (
            isSkillLoading || versionsQuery.isPending ? (
              <p className="p-6 text-sm text-muted-foreground">
                Loading version...
              </p>
            ) : (
              // Worded apart from the timeline's own failure next to it: the
              // head is unknown because the *skill* did not load, which is a
              // different read from the version list the timeline reports on.
              <LoadFailure
                message="Could not load this skill."
                onRetry={() => {
                  refetchSkill();
                  versionsQuery.refetch();
                }}
              />
            )
          ) : (
            <VersionPreview
              version={activeVersion}
              isHead={isHead}
              detail={detail ?? null}
              predecessor={predecessor}
              baselineFailed={baselineFailed}
              onRetryBaseline={() => predecessorQuery.refetch()}
              isLoading={isDetailLoading}
              isUnavailable={isDetailUnavailable}
              onRetry={() => refetchDetail()}
              versionFiles={versionFiles}
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
              fileCount={detail.files.length}
              droppedCount={filesDroppedByRestore}
            />
          }
          isPending={restoreVersion.isPending}
          onConfirm={handleRestore}
          // A restore only ever appends to the history, so it does not get the
          // red the delete and reset confirmations use.
          confirmVariant="default"
          confirmLabel={`Restore version ${activeVersion}`}
          pendingLabel="Restoring..."
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
  isError,
  onRetry,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onSelect,
}: {
  versions: SkillVersionSummary[];
  headVersion: number | null;
  activeVersion: number | null;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
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
  // Every skill has at least version 1, so an empty list after a failed fetch
  // is an outage, not a history. Saying "No versions" would state something
  // that is never true of a live skill.
  if (isError && versions.length === 0) {
    return (
      <LoadFailure
        message="Could not load this skill's versions."
        onRetry={onRetry}
      />
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
          <h3 className="sticky top-0 bg-background px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {group.label}
          </h3>
          {group.versions.map((version) => {
            const isActive = version.version === activeVersion;
            return (
              <button
                key={version.id}
                type="button"
                aria-current={isActive ? "true" : undefined}
                onClick={() => onSelect(version.version)}
                className={cn(
                  "block w-full cursor-pointer border-l-2 border-transparent px-3 py-2 text-left hover:bg-muted",
                  isActive && "border-l-primary bg-accent",
                )}
              >
                {/* One line per version: the day heading already dates them,
                    and the selected version's own header carries the time. */}
                <span className="flex items-center gap-1.5">
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
 * A read that failed, offered with a way to try again. Kept distinct from the
 * "no such version" copy on purpose: a transport failure supports no claim
 * about what the history holds, so it must not be phrased as one.
 */
function LoadFailure({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    // Sized to content rather than to the column: this renders both in the
    // 12rem timeline and across the full width of the preview pane.
    <div className="flex flex-col items-start gap-2 px-3 py-3">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/**
 * One row of the version's file tree. `path` is null for SKILL.md, which is not
 * a resource file but reads as one here.
 */
interface VersionEntry {
  path: string | null;
  change: SkillFileChange | null;
}

/**
 * The whole version as one file list: every file it holds, plus the ones its
 * predecessor had and it dropped. With a baseline, each row is badged with what
 * moved and a changed file opens as a diff; without one, the version is listed
 * and read on its own.
 */
function VersionPreview({
  version,
  isHead,
  detail,
  predecessor,
  baselineFailed,
  onRetryBaseline,
  isLoading,
  isUnavailable,
  onRetry,
  versionFiles,
  activeFilePath,
  onSelectFile,
}: {
  version: number;
  isHead: boolean;
  detail: SkillVersionDetail | null;
  predecessor: SkillVersionDetail | null;
  /** A baseline was expected and the read failed, so there is nothing to compare against. */
  baselineFailed: boolean;
  onRetryBaseline: () => void;
  isLoading: boolean;
  /** This version itself could not be read — distinct from it not existing. */
  isUnavailable: boolean;
  onRetry: () => void;
  versionFiles: VersionFile[];
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
  // A 404 is the only reading that supports "no longer available": the version
  // was pruned. A failed read supports nothing about the history at all, so it
  // gets the same treatment as a failed baseline — say what happened, and offer
  // a way back rather than leaving the dialog with no route out.
  if (!detail) {
    return isUnavailable ? (
      <LoadFailure
        message={`Version ${version} could not be loaded.`}
        onRetry={onRetry}
      />
    ) : (
      <p className="p-6 text-sm text-muted-foreground">
        This version is no longer available.
      </p>
    );
  }

  // With no baseline the manifest is in the same position as every other row:
  // there is nothing to compare it against, so it claims nothing.
  const manifestChange: SkillFileChange | null = !predecessor
    ? null
    : predecessor.content !== detail.content
      ? "changed"
      : "unchanged";
  const entries: VersionEntry[] = [
    { path: null, change: manifestChange },
    ...versionFiles.map((file) => ({ path: file.path, change: file.change })),
  ];

  // Selecting a version clears the file selection, so a path missing from this
  // version's list can only be a transient render — read it as SKILL.md, which
  // every version has.
  const selected = activeFilePath
    ? (versionFiles.find((file) => file.path === activeFilePath) ?? null)
    : null;
  const change = selected ? selected.change : manifestChange;
  const original = selected
    ? (selected.previous?.content ?? "")
    : (predecessor?.content ?? "");
  const modified = selected
    ? (selected.current?.content ?? "")
    : detail.content;
  // The copy actually rendered: this version's file, or — for one it removed —
  // the predecessor's. Only that side's encoding decides readability, so a
  // binary re-saved as text reads fine here even though the last version's copy
  // would not have.
  const rendered = selected ? (selected.current ?? selected.previous) : null;
  const isBinary = rendered?.encoding === "base64";
  // A diff needs two readable sides, and identical bytes have nothing to show;
  // either way the file is shown whole instead. No baseline is the same
  // situation: diffing against the empty string would draw the file as wholly
  // new when the older copy was never read — or never existed.
  const canDiff =
    change !== null &&
    change !== "unchanged" &&
    selected?.previous?.encoding !== "base64";
  const language = activeFilePath
    ? languageForPath(activeFilePath)
    : SKILL_MANIFEST_LANGUAGE;

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
      {baselineFailed ? (
        <LoadFailure
          message={`Version ${version - 1} could not be loaded, so this version is shown on its own.`}
          onRetry={onRetryBaseline}
        />
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr] gap-3 p-4">
        <div className="min-h-0 overflow-y-auto rounded-md border p-2">
          <VersionFileTree
            entries={entries}
            activePath={selected?.path ?? null}
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
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden rounded-md border">
          {/* The manifest row is the one file whose name does not say what it
                holds, so the pane says it instead: a reader comparing this
                against the editor's SKILL.md would otherwise find the
                frontmatter missing and read that as a lost edit. */}
          {selected ? null : (
            <p className="shrink-0 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
              The SKILL.md body. Name, description, and the rest of the
              frontmatter are stored separately and are not versioned.
            </p>
          )}
          <div className="min-h-0 flex-1">
            {isBinary ? (
              <p className="p-4 text-sm text-muted-foreground">
                This file is binary, so there is nothing to show here.
              </p>
            ) : !canDiff ? (
              <Editor
                height="100%"
                language={language}
                value={modified}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                }}
              />
            ) : (
              <DiffEditor
                height="100%"
                language={language}
                original={original}
                modified={modified}
                options={{
                  // A unified diff fits this dialog's narrow preview pane;
                  // side-by-side would halve the width for each revision.
                  renderSideBySide: false,
                  // Long, mostly-unchanged bodies collapse to the edited
                  // regions, so a one-line change does not require scrolling
                  // past everything that stayed the same.
                  hideUnchangedRegions: { enabled: true },
                }}
              />
            )}
          </div>
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

function RestoreEffects({
  version,
  fileCount,
  droppedCount,
}: {
  version: number;
  fileCount: number;
  /** Files the skill has today that this version does not, so a restore drops them. */
  droppedCount: number;
}) {
  return (
    <span className="block space-y-2">
      {/* The new version is deliberately not numbered here: a restore whose
          content matches the head is suppressed and creates nothing, and the
          head can move between this preview and the write. */}
      <span className="block">
        This creates a new version from version {version}&apos;s content.
        Nothing in the history is rewritten or removed.
      </span>
      <span className="block">
        It replaces the skill&apos;s instructions and its {fileCount} resource
        {fileCount === 1 ? " file" : " files"}.
        {droppedCount > 0 ? (
          <span>
            {" "}
            The {droppedCount} resource{droppedCount === 1 ? " file" : " files"}{" "}
            the skill has today that version {version} does not{" "}
            {droppedCount === 1 ? "is" : "are"} removed — recoverable by
            restoring a later version.
          </span>
        ) : null}
      </span>
      <span className="block">
        Everything else is left as it is: the name, description, and other
        frontmatter fields are not versioned, and neither are scope, teams,
        environments, or GitHub settings.
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
  css: "css",
  csv: "plaintext",
  html: "html",
  js: "javascript",
  json: "json",
  jsonl: "json",
  md: "markdown",
  py: "python",
  sh: "shell",
  toml: "ini",
  ts: "typescript",
  txt: "plaintext",
  yaml: "yaml",
  yml: "yaml",
};
