"use client";

import type { McpTaskPartData } from "@archestra/shared";
import { CircleSlashIcon, ClockIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { ToolStatusRow } from "@/components/chat/tool-status-row";

/**
 * Background-task detail inside an expanded tool call: how long it has been
 * running, and a way to cancel it. Deliberately lives here rather than as a
 * block in the transcript — a call taking a while is a property of that call,
 * not an event of its own.
 */
export function McpTaskStatusRow({
  task,
  onCancel,
  isCancelling,
}: {
  task: McpTaskPartData;
  onCancel: (taskId: string) => void;
  isCancelling: boolean;
}) {
  const isRunning = task.status === "working";
  const elapsedMs = useElapsedSince(task.startedAt, isRunning);

  // A finished task is already described by the tool's own result and header
  // state; repeating it here would just be noise.
  if (!isRunning && task.status !== "cancelled") {
    return null;
  }

  if (task.status === "cancelled") {
    return (
      <ToolStatusRow
        icon={<CircleSlashIcon className="mt-0.5 size-4 flex-none" />}
        title="Cancelled"
        description="This background task was cancelled before it finished."
        secondaryText={task.errorText}
      />
    );
  }

  return (
    <ToolStatusRow
      icon={<ClockIcon className="mt-0.5 size-4 flex-none text-amber-600" />}
      title="Running in the background"
      description="This call outlived the usual wait, so it keeps running as a background task."
      secondaryText={`${formatElapsed(elapsedMs)} elapsed`}
      actions={[
        {
          label: isCancelling ? "Cancelling…" : "Cancel",
          variant: "outline",
          icon: <XIcon className="size-3.5" />,
          onClick: () => onCancel(task.taskId),
          disabled: isCancelling,
        },
      ]}
    />
  );
}

/**
 * Ticks while the task runs. Derived from the absolute start epoch rather than
 * counted from mount, so a card that appears late — a reload part-way through
 * a long task — still shows the true elapsed time.
 */
export function useElapsedSince(startedAt: number, isRunning: boolean): number {
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

/** Short "12s" / "2m 05s" elapsed label. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
