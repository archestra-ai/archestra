"use client";

import type { McpTaskPartData } from "@archestra/shared";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CircleSlashIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Loader } from "@/components/ai-elements/loader";
import { ToolStatusRow } from "@/components/chat/tool-status-row";
import { cn } from "@/lib/utils";

interface McpTaskCardProps {
  task: McpTaskPartData;
  onCancel?: (taskId: string) => void;
  isCancelling?: boolean;
}

/**
 * A tool call that outlived the synchronous threshold and detached into a
 * durable background task. Shown while it runs — with a live elapsed clock and
 * a cancel action — and then in its terminal state, so the turn reads as an
 * explanation rather than a stall.
 */
export function McpTaskCard({
  task,
  onCancel,
  isCancelling = false,
}: McpTaskCardProps) {
  const isRunning = task.status === "working";
  const elapsedMs = useElapsedSince(task.startedAt, isRunning);

  return (
    <div
      className={cn(
        "mb-4 overflow-hidden rounded-lg border bg-card",
        task.status === "failed" && "border-destructive/40",
      )}
    >
      <ToolStatusRow
        icon={statusIcon(task.status)}
        title={statusTitle(task.status)}
        description={<span className="font-mono text-xs">{task.toolName}</span>}
        secondaryText={
          task.errorText
            ? task.errorText
            : `${formatDuration(elapsedMs)} elapsed`
        }
        tone={task.status === "failed" ? "destructive" : "default"}
        actions={
          isRunning && onCancel
            ? [
                {
                  label: isCancelling ? "Cancelling…" : "Cancel",
                  onClick: () => onCancel(task.taskId),
                  variant: "outline",
                  icon: <XIcon className="size-3.5" />,
                  disabled: isCancelling,
                },
              ]
            : []
        }
      />
    </div>
  );
}

/**
 * Ticks while the task runs. Derived from the absolute start epoch rather than
 * counted from mount, so a card that appears late — a reload part-way through
 * a long task — still shows the true elapsed time.
 */
function useElapsedSince(startedAt: number, isRunning: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isRunning) {
      return;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  return Math.max(0, now - startedAt);
}

function statusIcon(status: McpTaskPartData["status"]) {
  switch (status) {
    case "working":
      return <Loader size={16} />;
    case "completed":
      return <CheckCircle2Icon className="size-4 text-emerald-500" />;
    case "cancelled":
      return <CircleSlashIcon className="size-4 text-muted-foreground" />;
    default:
      return <AlertCircleIcon className="size-4" />;
  }
}

function statusTitle(status: McpTaskPartData["status"]): string {
  switch (status) {
    case "working":
      return "Running in the background";
    case "completed":
      return "Background task finished";
    case "cancelled":
      return "Background task cancelled";
    default:
      return "Background task failed";
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
