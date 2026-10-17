"use client";

import { GitCommitVertical } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";
import { LoadFailure } from "./load-failure";
import { ADDED_TEXT } from "./tones";

/**
 * What the pane reads: the whole version, or only what moved. The mode picks
 * the rendering too — the whole version reads as content, a change set reads
 * as comparisons — so a changed part can be read either way.
 */
export type VersionViewMode = "all" | "changes";

/** One clause of the change summary ("+2 tools", "system prompt edited"). */
export interface ChangePhrase {
  text: string;
  tone: "added" | "removed" | "changed";
}

/**
 * The strip under the header: the `v3..v4` range, the +/− totals with a
 * five-square diffstat, the change summary, and the Changes / All switch. A
 * version with no baseline says why in place of the range, and "Changes" is
 * not offered at all rather than offered and empty.
 */
export function DiffSummaryStrip({
  version,
  unavailableReason,
  baselineFailed,
  onRetryBaseline,
  added,
  removed,
  phrases,
  changeCount,
  heldCount,
  allLabel,
  mode,
  onModeChange,
}: {
  version: number;
  /** Why this version cannot be compared; null when it can. */
  unavailableReason: string | null;
  /** The baseline read failed, which is worth a retry rather than a shrug. */
  baselineFailed: boolean;
  onRetryBaseline: () => void;
  added: number;
  removed: number;
  phrases: ChangePhrase[];
  changeCount: number;
  heldCount: number;
  /** "All settings", "All files". */
  allLabel: string;
  mode: VersionViewMode;
  onModeChange: (mode: VersionViewMode) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-muted/30 px-6 py-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-xs">
        {unavailableReason === null ? (
          <>
            <span className="inline-flex h-5 items-center rounded-sm border bg-background px-1.5 text-[11px] text-muted-foreground">
              <span>v{version - 1}</span>
              <span className="px-px text-muted-foreground/50">..</span>
              <span className="text-foreground">v{version}</span>
            </span>
            {changeCount === 0 ? (
              <span className="text-muted-foreground">no changes</span>
            ) : (
              <>
                <DiffStat added={added} removed={removed} />
                <span className="flex flex-wrap items-center gap-y-1">
                  {phrases.map((phrase, index) => (
                    <span key={phrase.text} className="inline-flex">
                      {index > 0 ? (
                        <span className="pr-1.5 text-muted-foreground/60">
                          ,
                        </span>
                      ) : null}
                      <span
                        className={cn(
                          phrase.tone === "added" && ADDED_TEXT,
                          phrase.tone === "removed" && "text-destructive",
                          phrase.tone === "changed" && "text-foreground/85",
                        )}
                      >
                        {phrase.text}
                      </span>
                    </span>
                  ))}
                </span>
              </>
            )}
          </>
        ) : baselineFailed ? (
          <LoadFailure
            variant="warning"
            message={unavailableReason}
            onRetry={onRetryBaseline}
            className="w-auto font-sans"
          />
        ) : (
          <span className="inline-flex items-center gap-2 font-sans text-[13px] text-muted-foreground">
            <GitCommitVertical className="size-3.5 shrink-0" />
            <span>{unavailableReason}</span>
          </span>
        )}
      </div>
      <ViewModeSwitch
        mode={mode}
        onChange={onModeChange}
        changeCount={changeCount}
        heldCount={heldCount}
        allLabel={allLabel}
        unavailableReason={unavailableReason}
      />
    </div>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

function ViewModeSwitch({
  mode,
  onChange,
  changeCount,
  heldCount,
  allLabel,
  unavailableReason,
}: {
  mode: VersionViewMode;
  onChange: (mode: VersionViewMode) => void;
  changeCount: number;
  heldCount: number;
  allLabel: string;
  unavailableReason: string | null;
}) {
  return (
    <div className="inline-flex h-8 shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5">
      {unavailableReason ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex h-full">
              <Segment
                label="Changes"
                count={null}
                pressed={false}
                disabled
                onClick={() => {}}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-60">
            {unavailableReason}
          </TooltipContent>
        </Tooltip>
      ) : (
        <Segment
          label="Changes"
          count={changeCount}
          pressed={mode === "changes"}
          onClick={() => onChange("changes")}
        />
      )}
      <Segment
        label={allLabel}
        count={heldCount}
        pressed={mode === "all"}
        onClick={() => onChange("all")}
      />
    </div>
  );
}

function Segment({
  label,
  count,
  pressed,
  disabled = false,
  onClick,
}: {
  label: string;
  count: number | null;
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <UnstyledButton
      // Spelled out, because the count chip would otherwise run into the
      // label as "Changes2".
      aria-label={count === null ? label : `${label} (${count})`}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-full cursor-pointer items-center gap-1.5 rounded-[5px] px-2.5 font-mono text-[11px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45",
        pressed
          ? "bg-background text-foreground shadow-xs ring-1 ring-border"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <span>{label}</span>
      {count !== null ? (
        <span
          className={cn(
            "rounded-[3px] px-1 text-[10px] tabular-nums",
            pressed ? "bg-muted" : "bg-background/60",
          )}
        >
          {count}
        </span>
      ) : null}
    </UnstyledButton>
  );
}

/** GitHub's five-square diffstat, proportional to insertions vs deletions. */
function DiffStat({ added, removed }: { added: number; removed: number }) {
  const total = added + removed;
  const greens = total === 0 ? 0 : Math.round((added / total) * 5);
  const reds =
    total === 0 ? 0 : Math.min(5 - greens, Math.round((removed / total) * 5));
  return (
    <span className="inline-flex items-center gap-2 tabular-nums">
      <span className={ADDED_TEXT}>+{added}</span>
      <span className="text-destructive">−{removed}</span>
      <span className="inline-flex gap-px" aria-hidden>
        {DIFFSTAT_SLOTS.map((slot, index) => (
          <span
            key={slot}
            className={cn(
              "size-2 rounded-[1.5px]",
              index < greens
                ? "bg-emerald-500"
                : index < greens + reds
                  ? "bg-destructive"
                  : "bg-muted-foreground/20",
            )}
          />
        ))}
      </span>
    </span>
  );
}

const DIFFSTAT_SLOTS = ["a", "b", "c", "d", "e"];
