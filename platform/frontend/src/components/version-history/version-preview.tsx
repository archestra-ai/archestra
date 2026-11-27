"use client";

import { GIT_PROVIDER_LABELS } from "@archestra/shared";
import type { ReactNode } from "react";
import { GitProviderLogo } from "@/components/git/git-setup-chrome";
import { githubSourceUrlAtCommit } from "@/lib/skills/skill-source";
import { CommitHeader, UnreadVersionHeader } from "./commit-header";
import { DiffSummaryStrip, type VersionViewMode } from "./diff-summary-strip";
import { HunkScrollArea } from "./hunk-block";
import { LoadFailure } from "./load-failure";
import { NothingToDiff, PaneMessage, PaneSkeleton } from "./pane-states";
import { ShortHash } from "./refs";
import {
  summarizeFileChanges,
  type VersionFile,
  VersionFiles,
} from "./version-files";

/** What the preview reads of a version besides its files. */
interface PreviewedVersion {
  contentHash: string;
  createdAt: string;
  /** The Git commit the version came from, when a pull produced it. */
  sourceCommit: string | null;
}

/**
 * One version, read either way: every file it holds, or only what moved as a
 * set of diffs under a `git diff --stat`. The switcher decides both what is
 * listed and how each file renders, so a changed file can be read whole under
 * "All files" and as a comparison under "Changes".
 */
export function VersionPreview({
  version,
  isHead,
  detail,
  predecessor,
  files,
  manifestPath,
  baselineFailed,
  onRetryBaseline,
  isLoading,
  isUnavailable,
  onRetry,
  viewMode,
  onViewModeChange,
  onSelectVersion,
  sourceRef,
  sourceOrigin,
  sourceProvider,
  restoreAction,
}: {
  version: number;
  isHead: boolean;
  detail: PreviewedVersion | null;
  predecessor: PreviewedVersion | null;
  /**
   * The version's files, each paired with the predecessor's copy when there
   * is one. Empty while `detail` is not loaded.
   */
  files: VersionFile[];
  /** A file said by name in the summary when edited, such as SKILL.md. */
  manifestPath?: string;
  /** A baseline was expected and the read failed, so there is nothing to compare against. */
  baselineFailed: boolean;
  onRetryBaseline: () => void;
  isLoading: boolean;
  /** This version itself could not be read — distinct from it not existing. */
  isUnavailable: boolean;
  onRetry: () => void;
  /** Already settled against the baseline: "all" whenever there is none. */
  viewMode: VersionViewMode;
  onViewModeChange: (mode: VersionViewMode) => void;
  onSelectVersion: (version: number) => void;
  /** The item's provenance string, paired with a version's commit to link out. */
  sourceRef: string | null;
  sourceOrigin: string | null;
  sourceProvider: "github" | "gitlab" | null;
  restoreAction: ReactNode;
}) {
  if (isLoading && !detail) return <PaneSkeleton />;
  // A 404 is the only reading that supports "no longer available": the version
  // was pruned. A failed read supports nothing about the history at all, so it
  // says what happened and offers a way back rather than leaving the dialog
  // with no route out.
  if (!detail) {
    return (
      <>
        <UnreadVersionHeader version={version} action={restoreAction} />
        {isUnavailable ? (
          <div className="p-6">
            <LoadFailure
              message={`Version ${version} could not be loaded.`}
              onRetry={onRetry}
            />
          </div>
        ) : (
          <PaneMessage>This version is no longer available.</PaneMessage>
        )}
      </>
    );
  }

  // "All files" is the version itself, so a file it dropped has no hunk there.
  // "Changes" is what moved, which is exactly where a dropped file belongs,
  // and an untouched file has no place in it.
  const heldFiles = files.filter((file) => file.current !== null);
  const movedFiles = files.filter(
    (file) => file.change !== null && file.change !== "unchanged",
  );
  const entries = viewMode === "all" ? heldFiles : movedFiles;
  const summary = summarizeFileChanges(movedFiles, manifestPath);
  const provider = sourceProvider ?? "github";
  const sourceUrl = githubSourceUrlAtCommit({
    sourceRef,
    sourceOrigin,
    provider: sourceProvider,
    commit: detail.sourceCommit,
  });

  return (
    <>
      <CommitHeader
        version={version}
        isHead={isHead}
        hash={detail.contentHash}
        parentHash={predecessor?.contentHash ?? null}
        onSelectParent={onSelectVersion}
        createdAt={detail.createdAt}
        extraRows={
          // Only versions a Git pull produced. The link is named rather than
          // spelled out as a SHA, which stays in its title.
          sourceUrl && detail.sourceCommit ? (
            <>
              <dt className="leading-5 text-muted-foreground">source</dt>
              <dd className="flex min-w-0 items-center gap-2 leading-5">
                <GitProviderLogo provider={provider} size={12} />
                <ShortHash hash={detail.sourceCommit} />
                <a
                  href={sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate font-sans text-muted-foreground underline underline-offset-4 hover:text-primary"
                  title={`Open this version's source on ${GIT_PROVIDER_LABELS[provider]} (${detail.sourceCommit})`}
                >
                  Open version in {GIT_PROVIDER_LABELS[provider]}
                </a>
              </dd>
            </>
          ) : null
        }
        action={restoreAction}
      />
      <DiffSummaryStrip
        version={version}
        unavailableReason={
          predecessor ? null : compareUnavailableReason(version, baselineFailed)
        }
        baselineFailed={baselineFailed}
        onRetryBaseline={onRetryBaseline}
        added={summary.added}
        removed={summary.removed}
        phrases={summary.phrases}
        changeCount={movedFiles.length}
        heldCount={heldFiles.length}
        allLabel="All files"
        mode={viewMode}
        onModeChange={onViewModeChange}
      />
      <HunkScrollArea isStale={false}>
        {entries.length === 0 ? (
          <NothingToDiff>
            Version {version} holds the same files as version {version - 1}.
          </NothingToDiff>
        ) : (
          <VersionFiles
            // Remounting per version and reading resets every hunk's fold.
            key={`${version}-${viewMode}`}
            files={entries}
            mode={viewMode}
          />
        )}
      </HunkScrollArea>
    </>
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
