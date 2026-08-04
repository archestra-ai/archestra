"use client";

import { Github, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DiffEditor } from "@/components/diff-editor";
import { Editor } from "@/components/editor";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  type SkillVersionDetail,
  useResetSkill,
  useRestoreSkillVersion,
  useSkill,
  useSkillVersion,
  useSkillVersions,
} from "@/lib/skills/skill.query";
import { githubSourceUrlAtCommit } from "@/lib/skills/skill-source";
import {
  compareSkillVersionFiles,
  type SkillFileChange,
} from "@/lib/skills/skill-version-diff";
import { languageForPath } from "@/lib/skills/skill-version-format";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { LoadFailure } from "./load-failure";
import { type VersionEntry, VersionFileTree } from "./version-file-tree";
import { VersionTimeline } from "./version-timeline";

/**
 * What the pane reads: the whole version, or only the files that moved. The
 * mode picks the rendering too — the whole version reads as files, a change set
 * reads as diffs — so there is a way to read a changed file either way.
 */
type VersionViewMode = "all" | "changes";

/** The manifest is markdown; resource files take their language from the path. */
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
  const resetSkill = useResetSkill();

  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  // null = SKILL.md is open; otherwise a resource file path.
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  // Survives version selection: whoever came to read diffs keeps reading diffs.
  const [viewMode, setViewMode] = useState<VersionViewMode>("all");
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

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
  // Only a skill the app ships has a default to go back to.
  const isBuiltIn = skill?.sourceType === "built_in";

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
        <div className="flex w-full items-center gap-3">
          {/* Resetting a built-in skill is the same move as restoring: go back
              to a version someone already had. It sits here rather than in the
              row menu so both are reachable from the history you read to
              decide. */}
          {isBuiltIn ? (
            <PermissionButton
              permissions={{ skill: ["update"] }}
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              disabled={resetSkill.isPending}
              onClick={() => setConfirmingReset(true)}
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
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              activeFilePath={activeFilePath}
              onSelectFile={setActiveFilePath}
              sourceRef={skill?.sourceRef ?? null}
            />
          )}
        </section>
      </div>

      {skill && detail && activeVersion !== null ? (
        <DeleteConfirmDialog
          open={confirmingRestore}
          onOpenChange={setConfirmingRestore}
          title={`Restore version ${activeVersion}?`}
          description={restoreEffects({
            version: activeVersion,
            fileCount: detail.files.length,
            droppedCount: filesDroppedByRestore,
          })}
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
            if (!result) return;
            setConfirmingReset(false);
            // The reset landed as a new head, so the previewed version is no
            // longer what the skill looks like. Falling back to the head is
            // enough here — unlike a restore, the response carries no version
            // number to select.
            setSelectedVersion(null);
            setActiveFilePath(null);
          }}
          confirmLabel="Reset to default"
          pendingLabel="Resetting..."
        />
      ) : null}
    </StandardDialog>
  );
}

/**
 * One version, read either way: the whole thing as a file list, or only what
 * moved as a set of diffs. The switcher decides both what the tree lists and
 * how the pane renders it, so a changed file can be read whole under "All
 * files" and as a comparison under "Changes".
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
  viewMode,
  onViewModeChange,
  activeFilePath,
  onSelectFile,
  sourceRef,
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
  viewMode: VersionViewMode;
  onViewModeChange: (mode: VersionViewMode) => void;
  activeFilePath: string | null;
  onSelectFile: (path: string | null) => void;
  /** The skill's provenance string, paired with a version's commit to link out. */
  sourceRef: string | null;
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
  // Comparing takes a baseline, so a version without one stays on the whole
  // file list however the switcher was left on the version before it.
  const mode: VersionViewMode = predecessor ? viewMode : "all";

  // "All files" is the version itself, so a file it dropped has no row there.
  // "Changes" is what moved, which is exactly where a dropped file belongs.
  const heldFiles = versionFiles.filter((file) => file.current !== null);
  const movedFiles = versionFiles.filter(
    (file) => file.change !== null && file.change !== "unchanged",
  );
  const entries: VersionEntry[] =
    mode === "all"
      ? [
          { path: null, change: manifestChange },
          ...heldFiles.map((file) => ({
            path: file.path,
            change: file.change,
          })),
        ]
      : [
          // An unchanged body has no place in a list of what moved.
          ...(manifestChange === "changed"
            ? [{ path: null, change: manifestChange }]
            : []),
          ...movedFiles.map((file) => ({
            path: file.path,
            change: file.change,
          })),
        ];

  // The open file is a preference, not a guarantee: switching to "Changes" can
  // hide it, and so can a version that never held it. Fall back to the first
  // row rather than reading a path this list does not have.
  const activeEntry =
    entries.find((entry) => entry.path === activeFilePath) ??
    entries[0] ??
    null;
  const activePath = activeEntry?.path ?? null;
  const selected = activePath
    ? (versionFiles.find((file) => file.path === activePath) ?? null)
    : null;
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
  // A diff needs two readable sides. When only the older copy is binary — a
  // file re-saved as text — the newer one still reads, so it is shown whole
  // rather than compared against bytes nothing can render.
  const asDiff =
    mode === "changes" && selected?.previous?.encoding !== "base64";
  const language = activePath
    ? languageForPath(activePath)
    : SKILL_MANIFEST_LANGUAGE;
  const sourceUrl = githubSourceUrlAtCommit({
    sourceRef,
    commit: detail.sourceCommit,
  });

  return (
    <>
      <header className="flex items-baseline gap-2 px-4 pt-3">
        <h2 className="text-base font-semibold">Version {version}</h2>
        {isHead ? <Badge variant="outline">Current</Badge> : null}
        <span className="text-xs text-muted-foreground">
          {formatRelativeTimeFromNow(detail.createdAt)}
        </span>
        <div className="ml-auto flex items-baseline gap-3">
          {/* Provenance, shown only for versions a GitHub pull produced. Sits
              beside the content hash, which is a different identity entirely —
              the icon and the link affordance are what tell the two apart. */}
          {sourceUrl && detail.sourceCommit ? (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 font-mono text-xs text-muted-foreground underline underline-offset-4 hover:text-primary"
              title={`Open this version's source on GitHub (${detail.sourceCommit})`}
            >
              <Github className="size-3 shrink-0" />
              <span>{detail.sourceCommit.slice(0, 7)}</span>
            </a>
          ) : null}
          <span className="font-mono text-xs text-muted-foreground">
            {detail.contentHash.slice(0, 7)}
          </span>
        </div>
      </header>
      {baselineFailed ? (
        <LoadFailure
          message={`Version ${version - 1} could not be loaded, so this version is shown on its own.`}
          onRetry={onRetryBaseline}
        />
      ) : null}
      <div className="px-4 pt-3">
        <ViewModeSwitcher
          mode={mode}
          onChange={onViewModeChange}
          fileCount={heldFiles.length + 1}
          changeCount={
            movedFiles.length + (manifestChange === "changed" ? 1 : 0)
          }
          unavailableReason={
            predecessor
              ? null
              : compareUnavailableReason(version, baselineFailed)
          }
        />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr] gap-3 p-4">
        <div className="min-h-0 overflow-y-auto rounded-md border p-2">
          {activeEntry ? (
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
          ) : (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              Nothing changed in this version.
            </p>
          )}
        </div>

        <div className="min-h-0 overflow-hidden rounded-md border">
          {!activeEntry ? (
            <p className="p-4 text-sm text-muted-foreground">
              Nothing to show here.
            </p>
          ) : isBinary ? (
            <p className="p-4 text-sm text-muted-foreground">
              This file is binary, so there is nothing to show here.
            </p>
          ) : asDiff ? (
            <DiffEditor
              height="100%"
              language={language}
              original={original}
              modified={modified}
              options={{
                // A unified diff fits this dialog's narrow preview pane;
                // side-by-side would halve the width for each revision.
                renderSideBySide: false,
                // Long, mostly-unchanged bodies collapse to the edited regions,
                // so a one-line change does not require scrolling past
                // everything that stayed the same.
                hideUnchangedRegions: { enabled: true },
              }}
            />
          ) : (
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
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Read the whole version, or only what moved. "Changes" needs a predecessor to
 * compare against, so a version without one offers the reason instead — leaving
 * the control live would promise a comparison nothing can produce.
 */
function ViewModeSwitcher({
  mode,
  onChange,
  fileCount,
  changeCount,
  unavailableReason,
}: {
  mode: VersionViewMode;
  onChange: (mode: VersionViewMode) => void;
  fileCount: number;
  changeCount: number;
  unavailableReason: string | null;
}) {
  return (
    <ButtonGroup>
      <Button
        type="button"
        size="sm"
        variant={mode === "all" ? "secondary" : "outline"}
        onClick={() => onChange("all")}
      >
        All files ({fileCount})
      </Button>
      {unavailableReason ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button type="button" size="sm" variant="outline" disabled>
                Changes
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-60">
            {unavailableReason}
          </TooltipContent>
        </Tooltip>
      ) : (
        <Button
          type="button"
          size="sm"
          variant={mode === "changes" ? "secondary" : "outline"}
          onClick={() => onChange("changes")}
        >
          Changes ({changeCount})
        </Button>
      )}
    </ButtonGroup>
  );
}

/** Why this version cannot be compared — each reading is a different fact. */
function compareUnavailableReason(
  version: number,
  baselineFailed: boolean,
): string {
  if (version <= 1) {
    return "This is the earliest version, so there is nothing to compare it against.";
  }
  if (baselineFailed) {
    return `Version ${version - 1} could not be loaded, so there is nothing to compare against.`;
  }
  return `Loading version ${version - 1}...`;
}

/**
 * What a restore does to the skill as it stands today — the one thing a
 * confirmation has to answer. Everything a restore leaves alone, and the fact
 * that it appends rather than rewinds, is documented rather than repeated here
 * at the moment of clicking.
 *
 * The new version is deliberately not numbered: a restore whose content matches
 * the head is suppressed and creates nothing, and the head can move between
 * this preview and the write.
 */
function restoreEffects({
  version,
  fileCount,
  droppedCount,
}: {
  version: number;
  fileCount: number;
  /** Files the skill has today that this version does not, so a restore drops them. */
  droppedCount: number;
}): string {
  const files = `${fileCount} resource ${fileCount === 1 ? "file" : "files"}`;
  const restored = `Version ${version}'s instructions and its ${files} become the skill's content, as a new version.`;
  if (droppedCount === 0) return restored;
  const dropped = `${droppedCount} ${droppedCount === 1 ? "file" : "files"}`;
  return `${restored} The ${dropped} the skill has now that version ${version} does not ${droppedCount === 1 ? "is" : "are"} removed.`;
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
