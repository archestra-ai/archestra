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

/**
 * The manifest row is deliberately not called "SKILL.md": a version stores the
 * body alone, so this is a different document from the SKILL.md the editor
 * writes, which carries the frontmatter on top. Naming both files the same
 * thing would say the editor lost an edit that was never versioned.
 */
const SKILL_MANIFEST_LABEL = "Instructions";
/** The body is markdown; the row's label no longer carries an extension to read. */
const SKILL_MANIFEST_LANGUAGE = "markdown";

type ComparedVersionFile = ComparedSkillFile<
  SkillVersionDetail["files"][number]
>;

/**
 * What the tree says about a row. `unknown` is not a comparison result: it is
 * what a row reads as when the baseline could not be fetched, where every other
 * value would be a claim about a version nobody managed to look at.
 */
type VersionEntryChange = SkillFileChange | "unknown";

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
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  const versions = useMemo(
    () => versionsQuery.data?.pages.flatMap((page) => page?.data ?? []) ?? [],
    [versionsQuery.data],
  );
  const headVersion = skill?.latestVersion ?? versions[0]?.version ?? null;
  const activeVersion = selectedVersion ?? headVersion;
  const isHead = activeVersion !== null && activeVersion === headVersion;

  const { data: detail, isPending: isDetailLoading } = useSkillVersion(
    open ? skillId : null,
    activeVersion,
  );
  // Versions are contiguous from 1, so the diff baseline is simply the previous
  // number; version 1 has none and renders as an all-new document.
  const hasPredecessor = activeVersion !== null && activeVersion > 1;
  const predecessorQuery = useSkillVersion(
    open ? skillId : null,
    hasPredecessor ? (activeVersion as number) - 1 : null,
  );
  const predecessor = predecessorQuery.data ?? null;
  // A disabled query never leaves `pending`, so version 1's readiness is the
  // absence of a predecessor rather than the query's own status. A 404 settles
  // too: the version was pruned, the baseline is genuinely empty, and this
  // version reads as newly added.
  const isBaselineSettled = !hasPredecessor || !predecessorQuery.isPending;
  // A predecessor that *failed* is a third state. It settles like a 404 — the
  // baseline is empty either way — but it means something different: nobody
  // read the older version, so nothing here can be called added or changed.
  // Annotating it like a pruned predecessor would report a transport failure
  // as a fact about the skill's history.
  const isBaselineUnavailable = hasPredecessor && predecessorQuery.isError;

  const comparedFiles = useMemo(
    () =>
      detail && isBaselineSettled
        ? compareSkillVersionFiles(detail.files, predecessor?.files ?? [])
        : [],
    [detail, predecessor, isBaselineSettled],
  );

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
  const isBuiltIn = skill?.sourceType === "built_in";
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
    // what the skill looks like — jump the selection to the version just made.
    setSelectedVersion(result.latestVersion);
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
          {activeVersion === null ? (
            <p className="p-6 text-sm text-muted-foreground">
              This skill has no recorded versions yet.
            </p>
          ) : (
            <VersionPreview
              version={activeVersion}
              isHead={isHead}
              detail={detail ?? null}
              predecessor={predecessor}
              isBaselineSettled={isBaselineSettled}
              isBaselineUnavailable={isBaselineUnavailable}
              onRetryBaseline={() => predecessorQuery.refetch()}
              isLoading={isDetailLoading}
              comparedFiles={comparedFiles}
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
      <div className="space-y-2 px-3 py-3">
        <p className="text-sm text-muted-foreground">
          Could not load this skill&apos;s versions.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          onClick={onRetry}
        >
          Retry
        </Button>
      </div>
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
 * One row of the version's file tree. `path` is null for SKILL.md, which is not
 * a resource file but reads as one here.
 */
interface VersionEntry {
  path: string | null;
  change: VersionEntryChange;
}

/**
 * The whole version as one annotated file list: every file it holds, plus the
 * ones its predecessor had and it dropped, each badged with what moved. A file
 * that changed opens as a diff against the predecessor; one that did not opens
 * as itself, since a diff of identical bytes shows nothing.
 */
function VersionPreview({
  version,
  isHead,
  detail,
  predecessor,
  isBaselineSettled,
  isBaselineUnavailable,
  onRetryBaseline,
  isLoading,
  comparedFiles,
  activeFilePath,
  onSelectFile,
}: {
  version: number;
  isHead: boolean;
  detail: SkillVersionDetail | null;
  predecessor: SkillVersionDetail | null;
  isBaselineSettled: boolean;
  /** The predecessor could not be read, so nothing here is a comparison. */
  isBaselineUnavailable: boolean;
  onRetryBaseline: () => void;
  isLoading: boolean;
  comparedFiles: ComparedVersionFile[];
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

  // A baseline that failed to load is empty exactly like a pruned one, and
  // comparing against it yields `added` for everything — a reading the failure
  // does not support. Every annotation goes through here so the tree, the
  // manifest row, and the preview pane cannot disagree about it.
  const annotate = (change: SkillFileChange): VersionEntryChange =>
    isBaselineUnavailable ? "unknown" : change;

  // No baseline — version 1, or a predecessor the API no longer has — makes the
  // whole version read as added, matching how its files compare.
  const manifestChange = annotate(
    !predecessor
      ? "added"
      : predecessor.content !== detail.content
        ? "changed"
        : "unchanged",
  );
  const entries: VersionEntry[] = [
    { path: null, change: manifestChange },
    ...comparedFiles.map((file) => ({
      path: file.path,
      change: annotate(file.change),
    })),
  ];

  // Selecting a version clears the file selection, so a path missing from this
  // version's list can only be a transient render — read it as SKILL.md, which
  // every version has.
  const compared = activeFilePath
    ? (comparedFiles.find((file) => file.path === activeFilePath) ?? null)
    : null;
  const change = compared ? annotate(compared.change) : manifestChange;
  const original = compared
    ? (compared.previous?.content ?? "")
    : (predecessor?.content ?? "");
  const modified = compared
    ? (compared.current?.content ?? "")
    : detail.content;
  // The copy actually rendered: this version's file, or — for one it removed —
  // the predecessor's. Only that side's encoding decides readability, so a
  // binary re-saved as text reads fine here even though the last version's copy
  // would not have.
  const rendered = compared ? (compared.current ?? compared.previous) : null;
  const isBinary = rendered?.encoding === "base64";
  // A diff needs two readable sides, and identical bytes have nothing to show;
  // either way the file is shown whole instead. An unreadable baseline is the
  // same situation: diffing against the empty string would draw the file as
  // wholly new when all that is known is that the older copy never arrived.
  const canDiff =
    change !== "unchanged" &&
    change !== "unknown" &&
    compared?.previous?.encoding !== "base64";
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

      {isBaselineUnavailable ? (
        <div className="mx-4 mt-3 flex items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <span className="flex-1">
            Version {version - 1} could not be loaded, so this version is shown
            as it stands rather than as a comparison.
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRetryBaseline}
          >
            Retry
          </Button>
        </div>
      ) : null}

      {isBaselineSettled ? (
        <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr] gap-3 p-4">
          <div className="min-h-0 overflow-y-auto rounded-md border p-2">
            <VersionFileTree
              entries={entries}
              activePath={compared?.path ?? null}
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
            {compared ? null : (
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
      ) : (
        <p className="p-6 text-sm text-muted-foreground">
          Comparing with version {version - 1}...
        </p>
      )}
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
  change: VersionEntryChange;
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
      {/* `unchanged` and `unknown` both go unbadged, for opposite reasons: one
          is a comparison that found nothing, the other is no comparison at all.
          The banner above the tree carries the distinction. */}
      {change === "unchanged" || change === "unknown" ? null : (
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
  droppedCount,
}: {
  version: number;
  nextVersion: number;
  fileCount: number;
  /** Files the skill has today that this version does not, so a restore drops them. */
  droppedCount: number;
}) {
  return (
    <span className="block space-y-2">
      <span className="block">
        This creates version {nextVersion} from version {version}&apos;s
        content. Nothing in the history is rewritten or removed.
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
