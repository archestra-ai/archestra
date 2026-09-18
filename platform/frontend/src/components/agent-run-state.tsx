"use client";

import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { RunStateIcon } from "@/components/chat/run-state-icon";
import { LogConsole } from "@/components/log-console";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import {
  ATTENTION_CHIP_CLASS,
  RUN_GLYPH_DOT_CLASS,
  type RunStatusInput,
  runStatusMarks,
} from "@/lib/agent-run-status-marks";
import { cn } from "@/lib/utils";

/**
 * The run header pill: the same two facts as the sidebar glyph, in words. The
 * inline dot follows the machine; attention renders as a chip with its reason.
 */
export function AgentRunState({
  compact = false,
  iconOnly = false,
  statusReason,
  ...run
}: RunStatusInput & {
  compact?: boolean;
  iconOnly?: boolean;
  statusReason?: string | null;
}) {
  const marks = runStatusMarks(run);
  const [detailsOpen, setDetailsOpen] = useState(false);

  if (iconOnly) return <RunStateIcon {...run} className="size-4" />;

  const pill = (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 font-medium text-muted-foreground",
        compact ? "text-[11px]" : "text-xs",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          RUN_GLYPH_DOT_CLASS[marks.glyph],
        )}
      />
      <span>{marks.label}</span>
      {marks.suffix && (
        <span className="font-normal text-muted-foreground/70">
          · {marks.suffix}
        </span>
      )}
    </span>
  );

  if (!marks.chip) return pill;

  const chipClassName = cn(
    "inline-flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[10px] font-medium",
    ATTENTION_CHIP_CLASS[marks.chip.tone],
  );
  const chipLabel = marks.chip.label;

  if (marks.chip.tone !== "failed" || !statusReason) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5">
        {pill}
        <span className={chipClassName}>{chipLabel}</span>
      </span>
    );
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {pill}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={cn(
          chipClassName,
          "hover:border-destructive/30 hover:bg-destructive/10",
        )}
        aria-label={`View ${chipLabel.toLowerCase()} details`}
        onClick={() => setDetailsOpen(true)}
      >
        <span>{chipLabel}</span>
        <span aria-hidden className="h-2.5 w-px bg-border" />
        <span className="text-[9px] font-normal text-muted-foreground">
          Details
        </span>
        <ChevronRight className="size-2.5 text-muted-foreground/70" />
      </Button>
      <StandardDialog
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        title={`Run ${chipLabel.toLowerCase()}`}
        description="The run reported this reason when it stopped."
        size="medium"
      >
        <LogConsole
          content={formatRunStatusReason(statusReason)}
          contentTone="error"
          copySuccessMessage="Run details copied to clipboard"
          className="h-64"
        />
      </StandardDialog>
    </span>
  );
}

function formatRunStatusReason(reason: string): string {
  const bodyMarker = "Body: ";
  const bodyStart = reason.indexOf(bodyMarker);
  if (bodyStart === -1) return reason;

  const parsedBody = parseEmbeddedJson(
    reason.slice(bodyStart + bodyMarker.length),
  );
  if (parsedBody === null) return reason;

  const summary = reason.slice(0, bodyStart).trimEnd();
  return `${summary}\n\nBody:\n${JSON.stringify(parsedBody, null, 2)}`;
}

function parseEmbeddedJson(value: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(value.trim());
    return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
  } catch {
    return null;
  }
}
