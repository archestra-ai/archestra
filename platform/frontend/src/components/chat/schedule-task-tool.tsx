"use client";

import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  ListChecks,
  Pencil,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useProfile } from "@/lib/agent.query";
import { formatCronSchedule } from "@/lib/utils/format-cron";

type ScheduleTaskOperation = "create" | "list" | "update" | "delete";

interface ScheduleTaskToolProps {
  operation: ScheduleTaskOperation;
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  errorText?: string;
}

/**
 * Normalized success payload covering all three task-modifying tools
 */
type SuccessOutput = {
  id: string;
  name: string;
  agentId: string;
  cronExpression: string;
  timezone: string;
  enabled?: boolean;
};

type ListOutput = {
  total: number;
  tasks: SuccessOutput[];
};

function unwrapOutputCandidate(
  output: unknown,
): Record<string, unknown> | null {
  const parsedOutput = parseJsonObject(output) ?? output;
  if (!parsedOutput || typeof parsedOutput !== "object") return null;

  if ("structuredContent" in parsedOutput) {
    const structured = (parsedOutput as { structuredContent?: unknown })
      .structuredContent;
    return parseJsonObject(structured) ?? objectRecord(structured);
  }

  if ("content" in parsedOutput) {
    const content = (parsedOutput as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        const text = (item as { text?: unknown }).text;
        const parsedText = parseJsonObject(text);
        if (parsedText) return parsedText;
      }
    }
  }

  return objectRecord(parsedOutput);
}

function extractCandidate(
  part: ToolUIPart | DynamicToolUIPart,
  toolResultPart: ToolUIPart | DynamicToolUIPart | null,
): Record<string, unknown> | null {
  const output =
    (toolResultPart as { output?: unknown } | null)?.output ??
    (part as { output?: unknown }).output;
  return unwrapOutputCandidate(output);
}

function extractSuccessOutput(
  part: ToolUIPart | DynamicToolUIPart,
  toolResultPart: ToolUIPart | DynamicToolUIPart | null,
): SuccessOutput | null {
  const c = extractCandidate(part, toolResultPart);
  if (!c) return null;

  if ("success" in c && c.success !== true) return null;

  // create_scheduled_task returns scheduleTriggerId; update/delete return id.
  const id =
    typeof c.scheduleTriggerId === "string"
      ? c.scheduleTriggerId
      : typeof c.id === "string"
        ? c.id
        : null;
  if (!id) return null;
  if (
    typeof c.name !== "string" ||
    typeof c.agentId !== "string" ||
    typeof c.cronExpression !== "string" ||
    typeof c.timezone !== "string"
  ) {
    return null;
  }

  return {
    id,
    name: c.name,
    agentId: c.agentId,
    cronExpression: c.cronExpression,
    timezone: c.timezone,
    enabled: typeof c.enabled === "boolean" ? c.enabled : undefined,
  };
}

function extractListOutput(
  part: ToolUIPart | DynamicToolUIPart,
  toolResultPart: ToolUIPart | DynamicToolUIPart | null,
): ListOutput | null {
  const c = extractCandidate(part, toolResultPart);
  if (!c || !Array.isArray(c.tasks)) return null;

  const tasks = c.tasks.flatMap((task) => {
    const record = objectRecord(task);
    if (!record) return [];
    if (
      typeof record.id !== "string" ||
      typeof record.name !== "string" ||
      typeof record.agentId !== "string" ||
      typeof record.cronExpression !== "string" ||
      typeof record.timezone !== "string"
    ) {
      return [];
    }

    return [
      {
        id: record.id,
        name: record.name,
        agentId: record.agentId,
        cronExpression: record.cronExpression,
        timezone: record.timezone,
        enabled:
          typeof record.enabled === "boolean" ? record.enabled : undefined,
      },
    ];
  });

  return {
    total: typeof c.total === "number" ? c.total : tasks.length,
    tasks,
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    return objectRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function extractInputName(part: ToolUIPart | DynamicToolUIPart): string | null {
  if (!part.input || typeof part.input !== "object") return null;
  const name = (part.input as { name?: unknown }).name;
  return typeof name === "string" && name.trim().length > 0 ? name : null;
}

const HEADER_TEXT: Record<ScheduleTaskOperation, string> = {
  create: "Scheduled task created",
  list: "Scheduled tasks",
  update: "Scheduled task updated",
  delete: "Scheduled task deleted",
};

const ERROR_HEADER: Record<ScheduleTaskOperation, string> = {
  create: "Couldn't create scheduled task",
  list: "Couldn't list scheduled tasks",
  update: "Couldn't update scheduled task",
  delete: "Couldn't delete scheduled task",
};

const HEADER_ICON: Record<ScheduleTaskOperation, typeof CheckCircle2> = {
  create: CheckCircle2,
  list: ListChecks,
  update: Pencil,
  delete: Trash2,
};

const HEADER_ICON_COLOR: Record<ScheduleTaskOperation, string> = {
  create: "text-emerald-600",
  list: "text-primary",
  update: "text-blue-600",
  delete: "text-destructive",
};

/**
 * Inline card shown after the agent calls one of the
 * archestra__*_scheduled_task tools.
 */
export function ScheduleTaskTool({
  operation,
  part,
  toolResultPart,
  errorText,
}: ScheduleTaskToolProps) {
  const success = extractSuccessOutput(part, toolResultPart);
  const listOutput =
    operation === "list" && !extractInputName(part)
      ? extractListOutput(part, toolResultPart)
      : null;

  if (errorText) {
    const attemptedName = extractInputName(part);
    return (
      <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div className="min-w-0">
          <div className="font-medium text-destructive">
            {ERROR_HEADER[operation]}
            {attemptedName ? ` "${attemptedName}"` : ""}
          </div>
          <div className="mt-0.5 wrap-break-word text-xs text-destructive/80">
            {errorText}
          </div>
        </div>
      </div>
    );
  }

  if (!success) {
    if (listOutput) {
      return <ScheduleTaskListCard output={listOutput} />;
    }
    return null;
  }

  return <ScheduleTaskCard operation={operation} output={success} />;
}

function ScheduleTaskListCard({ output }: { output: ListOutput }) {
  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-border/60 bg-card">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 shrink-0 text-primary" />
          <span className="text-xs font-medium text-muted-foreground">
            Scheduled tasks
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          {output.total} total
        </span>
      </div>
      {output.tasks.length === 0 ? (
        <div className="px-3 py-3 text-sm text-muted-foreground">
          No scheduled tasks found.
        </div>
      ) : (
        <div className="divide-y divide-border/60">
          {output.tasks.map((task) => (
            <div key={task.id} className="grid gap-1 px-3 py-2.5 text-sm">
              <div className="flex items-start justify-between gap-3">
                <Link
                  href={`/scheduled-tasks/${task.id}`}
                  className="min-w-0 truncate font-medium text-foreground hover:underline"
                >
                  {task.name}
                </Link>
                {task.enabled !== undefined && (
                  <span className="shrink-0 rounded border border-border/70 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {task.enabled ? "Enabled" : "Paused"}
                  </span>
                )}
              </div>
              <div className="wrap-break-word text-xs text-muted-foreground">
                {formatCronSchedule(task.cronExpression)}
                {" · "}
                {task.timezone}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ScheduleTaskCard({
  operation,
  output,
}: {
  operation: ScheduleTaskOperation;
  output: SuccessOutput;
}) {
  const { data: agent } = useProfile(output.agentId);
  const scheduleDescription = formatCronSchedule(output.cronExpression);
  const HeaderIcon = HEADER_ICON[operation];

  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-border/60 bg-card">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <HeaderIcon
          className={`h-4 w-4 shrink-0 ${HEADER_ICON_COLOR[operation]}`}
        />
        <span className="text-xs font-medium text-muted-foreground">
          {HEADER_TEXT[operation]}
        </span>
      </div>
      <div className="space-y-2 px-3 py-3">
        <div className="flex items-start gap-2">
          <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div
              className={
                operation === "delete"
                  ? "font-medium text-muted-foreground line-through"
                  : "font-medium text-foreground"
              }
            >
              {output.name}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {scheduleDescription}
              {" · "}
              {output.timezone}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground">
            Agent:{" "}
            <span className="text-foreground">{agent?.name ?? "Loading…"}</span>
          </span>
          {operation !== "delete" && (
            <Link
              href={`/scheduled-tasks/${output.id}`}
              className="font-medium text-primary hover:underline"
            >
              View task →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
