"use client";

import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { RunStateIcon } from "@/components/chat/run-state-icon";
import { LogConsole } from "@/components/log-console";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import {
  GLYPH_CLASS,
  type RunStatusInput,
  runStatusMarks,
} from "@/lib/agent-run-status-marks";
import { cn } from "@/lib/utils";

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
        className={cn("size-1.5 rounded-full", GLYPH_CLASS[marks.glyph].dot)}
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
    "h-5 rounded-md px-1.5 text-[10px]",
    CHIP_CLASS[marks.chip.tone],
  );
  const chipLabel = marks.chip.label;

  if (marks.chip.tone !== "failed" || !statusReason) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5">
        {pill}
        <Badge variant="outline" className={chipClassName}>
          {chipLabel}
        </Badge>
      </span>
    );
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {pill}
      <Badge
        asChild
        variant="outline"
        className={cn(
          chipClassName,
          "cursor-pointer hover:border-destructive/30 hover:bg-destructive/10",
        )}
      >
        <button
          type="button"
          aria-label={`View ${chipLabel.toLowerCase()} details`}
          onClick={() => setDetailsOpen(true)}
        >
          <span>{chipLabel}</span>
          <span aria-hidden className="h-2.5 w-px bg-border" />
          <span className="text-[9px] font-normal text-muted-foreground">
            Details
          </span>
          <ChevronRight className="size-2.5 text-muted-foreground/70" />
        </button>
      </Badge>
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

const CHIP_CLASS = {
  attention:
    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  failed: "border-destructive/20 bg-destructive/5 text-destructive",
};

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
