"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SkillVersionSummary } from "@/lib/skills/skill.query";
import { groupVersionsByDay } from "@/lib/skills/skill-version-format";
import { cn } from "@/lib/utils";
import { LoadFailure } from "./load-failure";

/**
 * A skill's versions, newest first, grouped by day. Selecting one previews it;
 * older pages are pulled in on demand rather than all at once.
 */
export function VersionTimeline({
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
      {groupVersionsByDay(versions).map((group) => (
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
