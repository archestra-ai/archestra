"use client";

import { DiffStatTable } from "@/components/version-history/diff-stat-table";
import type {
  ChangePhrase,
  VersionViewMode,
} from "@/components/version-history/diff-summary-strip";
import {
  HunkBlock,
  HunkEditor,
  HunkNote,
  HunkStat,
} from "@/components/version-history/hunk-block";
import { lineCount, lineDelta } from "@/components/version-history/line-delta";
import type { SkillFileChange } from "@/lib/skills/skill-version-diff";

/** One side of a file: its bytes and how they are stored. */
interface VersionFileSide {
  content: string;
  encoding: "utf8" | "base64";
}

/**
 * One file of the version being read, paired with the predecessor's copy when
 * there is one. `change` is null when there is no baseline (version 1, or a
 * predecessor that could not be read), since nothing about the file is then a
 * comparison, and calling it added would report a failed fetch as a fact
 * about the history.
 */
export interface VersionFile {
  path: string;
  change: SkillFileChange | null;
  /** This version's copy; null for a file it removed. */
  current: VersionFileSide | null;
  /** The predecessor's copy; null for a file it did not have. */
  previous: VersionFileSide | null;
  language: string;
}

/**
 * A version's files as diff hunks, one per path like `git diff`: under
 * "Changes", a `--stat` of the files that moved and each one read as a diff;
 * under "All files", every file the version holds, read whole.
 */
export function VersionFiles({
  files,
  mode,
}: {
  files: VersionFile[];
  mode: VersionViewMode;
}) {
  return (
    <div className="flex flex-col gap-3">
      {mode === "changes" ? (
        <DiffStatTable
          unit="file"
          rows={files.map((file) => ({
            id: file.path,
            path: file.path,
            ...fileDelta(file),
            status: NAME_STATUS[file.change ?? "unchanged"],
          }))}
        />
      ) : null}
      {files.map((file) => (
        <HunkBlock
          key={file.path}
          id={file.path}
          label={file.path}
          stat={<FileStat file={file} mode={mode} />}
          change={
            file.change === null || file.change === "unchanged"
              ? null
              : file.change
          }
        >
          <FileBody file={file} mode={mode} />
        </HunkBlock>
      ))}
    </div>
  );
}

/**
 * The strip's one-liner ("SKILL.md edited, +1 file") and its +/− totals.
 * `manifestPath` names a file that is said by name when edited, where the
 * history has one; the rest are counted.
 */
export function summarizeFileChanges(
  moved: VersionFile[],
  manifestPath?: string,
): {
  phrases: ChangePhrase[];
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  const counts = { added: 0, removed: 0, changed: 0 };
  let manifestEdited = false;
  for (const file of moved) {
    const delta = fileDelta(file);
    added += delta.added;
    removed += delta.removed;
    if (file.change === null || file.change === "unchanged") continue;
    if (manifestPath !== undefined && file.path === manifestPath) {
      manifestEdited = true;
    } else {
      counts[file.change] += 1;
    }
  }
  const phrases: ChangePhrase[] = [];
  if (manifestEdited) {
    phrases.push({ text: `${manifestPath} edited`, tone: "changed" });
  }
  if (counts.added) {
    phrases.push({ text: `+${files(counts.added)}`, tone: "added" });
  }
  if (counts.removed) {
    phrases.push({ text: `−${files(counts.removed)}`, tone: "removed" });
  }
  if (counts.changed) {
    phrases.push({ text: `${files(counts.changed)} edited`, tone: "changed" });
  }
  return { phrases, added, removed };
}

// ============================================================================
// Internal helpers
// ============================================================================

const NAME_STATUS = {
  added: "A",
  removed: "D",
  changed: "M",
  unchanged: undefined,
} as const;

function files(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
}

/** The copy actually rendered: this version's, or the predecessor's for a removed file. */
function renderedSide(file: VersionFile): VersionFileSide | null {
  return file.current ?? file.previous;
}

function isBinary(file: VersionFile): boolean {
  return renderedSide(file)?.encoding === "base64";
}

/** Line weight of a file's change; binary files have no lines to count. */
function fileDelta(file: VersionFile): { added: number; removed: number } {
  if (isBinary(file) || file.previous?.encoding === "base64") {
    return { added: 0, removed: 0 };
  }
  return lineDelta(
    file.previous?.content ?? null,
    file.current?.content ?? null,
  );
}

function FileStat({
  file,
  mode,
}: {
  file: VersionFile;
  mode: VersionViewMode;
}) {
  if (isBinary(file)) return <HunkStat summary="binary" />;
  if (mode === "changes") return <HunkStat {...fileDelta(file)} />;
  const lines = lineCount(file.current?.content ?? null);
  return <HunkStat summary={`${lines} ${lines === 1 ? "line" : "lines"}`} />;
}

function FileBody({
  file,
  mode,
}: {
  file: VersionFile;
  mode: VersionViewMode;
}) {
  // Only the rendered side's encoding decides readability, so a binary
  // re-saved as text reads fine here even though the last version's copy
  // would not have.
  if (isBinary(file)) {
    return (
      <HunkNote>
        This file is binary, so there is nothing to show here.
      </HunkNote>
    );
  }
  // A diff needs two readable sides. When only the older copy is binary — a
  // file re-saved as text — the newer one still reads, so it is shown whole
  // rather than compared against bytes nothing can render.
  const asDiff = mode === "changes" && file.previous?.encoding !== "base64";
  return asDiff ? (
    <HunkEditor
      language={file.language}
      value={file.current?.content ?? ""}
      original={file.previous?.content ?? ""}
    />
  ) : (
    <HunkEditor language={file.language} value={file.current?.content ?? ""} />
  );
}
