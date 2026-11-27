import { useMemo } from "react";
import type { RailVersion } from "./commit-graph-rail";

/** The pages of a history's version list, as an infinite query holds them. */
interface VersionPages<V extends RailVersion> {
  data?: { pages: Array<{ data: V[] } | null | undefined> };
}

/**
 * Where a history dialog stands: the versions loaded so far, which one is the
 * head, which one is being read, and which one it is compared against.
 *
 * Versions are contiguous from 1, so the baseline of a version is the number
 * before it; version 1 has none.
 */
export function useVersionTimeline<V extends RailVersion>(params: {
  versionsQuery: VersionPages<V>;
  /** The head as the item itself reports it, when it does. */
  headHint: number | null | undefined;
  /** The version picked in the rail; null reads the head. */
  selectedVersion: number | null;
}) {
  const { versionsQuery, headHint, selectedVersion } = params;
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
  const headVersion = headHint ?? versions[0]?.version ?? null;
  const activeVersion = selectedVersion ?? headVersion;
  const hasPredecessor = activeVersion !== null && activeVersion > 1;
  return {
    versions,
    headVersion,
    activeVersion,
    isHead: activeVersion !== null && activeVersion === headVersion,
    hasPredecessor,
    predecessorVersion: hasPredecessor ? (activeVersion as number) - 1 : null,
  };
}

export type VersionTimeline<V extends RailVersion = RailVersion> = ReturnType<
  typeof useVersionTimeline<V>
>;
