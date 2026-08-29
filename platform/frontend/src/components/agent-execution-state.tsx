"use client";

import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { LogConsole } from "@/components/log-console";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AgentExecution } from "@/lib/agent-background-execution.query";
import { cn } from "@/lib/utils";

export function AgentExecutionState({
  state,
  compact = false,
  iconOnly = false,
  statusReason,
}: {
  state: AgentExecution["state"];
  compact?: boolean;
  iconOnly?: boolean;
  statusReason?: string | null;
}) {
  const presentation = executionStatePresentation(state);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const dot = (
    <span
      className={cn(
        "size-1.5 rounded-full",
        presentation.pulse && "animate-pulse",
        presentation.dotClassName,
      )}
    />
  );
  const status = (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 font-medium text-muted-foreground",
        compact ? "text-[11px]" : "text-xs",
        statusReason && "gap-1 text-[10px] text-foreground",
      )}
    >
      {dot}
      <span>{presentation.label}</span>
    </span>
  );

  if (iconOnly) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            aria-label={presentation.label}
            className="inline-flex size-5 shrink-0 items-center justify-center"
          >
            {dot}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">{presentation.label}</TooltipContent>
      </Tooltip>
    );
  }

  if (!statusReason) return status;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="-mx-0.5 h-5 gap-1 rounded-md border-destructive/15 bg-destructive/5 px-1.5 hover:border-destructive/25 hover:bg-destructive/10"
        aria-label={`View ${presentation.label.toLowerCase()} details`}
        onClick={() => setDetailsOpen(true)}
      >
        {status}
        <span aria-hidden className="h-2.5 w-px bg-border" />
        <span className="text-[9px] font-normal text-muted-foreground">
          Details
        </span>
        <ChevronRight className="size-2.5 text-muted-foreground/70" />
      </Button>
      <StandardDialog
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        title={`Execution ${presentation.label.toLowerCase()}`}
        description="The execution reported this reason when it stopped."
        size="medium"
      >
        <LogConsole
          content={formatExecutionStatusReason(statusReason)}
          contentTone="error"
          copySuccessMessage="Execution details copied to clipboard"
          className="h-64"
        />
      </StandardDialog>
    </>
  );
}

function executionStatePresentation(state: AgentExecution["state"]): {
  label: string;
  dotClassName: string;
  pulse?: boolean;
} {
  switch (state) {
    case "TASK_STATE_WORKING":
      return { label: "Running", dotClassName: "bg-emerald-500" };
    case "TASK_STATE_COMPLETED":
      return { label: "Completed", dotClassName: "bg-muted-foreground/50" };
    case "TASK_STATE_FAILED":
      return { label: "Failed", dotClassName: "bg-destructive" };
    case "TASK_STATE_CANCELED":
      return { label: "Canceled", dotClassName: "bg-muted-foreground/50" };
    case "TASK_STATE_REJECTED":
      return { label: "Rejected", dotClassName: "bg-destructive" };
    case "TASK_STATE_INPUT_REQUIRED":
      return { label: "Needs input", dotClassName: "bg-amber-500" };
    case "TASK_STATE_AUTH_REQUIRED":
      return { label: "Needs auth", dotClassName: "bg-amber-500" };
    case "TASK_STATE_SUBMITTED":
      return { label: "Starting", dotClassName: "bg-sky-500", pulse: true };
    default:
      return { label: "Pending", dotClassName: "bg-sky-500", pulse: true };
  }
}

function formatExecutionStatusReason(reason: string): string {
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
