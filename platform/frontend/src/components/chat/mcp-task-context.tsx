"use client";

import type { McpTaskPartData } from "@archestra/shared";
import { createContext, type ReactNode, useContext } from "react";

interface McpTaskContextValue {
  /** Background tasks for this conversation, keyed by the tool call they back. */
  byToolCallId: Map<string, McpTaskPartData>;
  cancel: (taskId: string) => void;
  cancellingTaskId: string | null;
}

const McpTaskContext = createContext<McpTaskContextValue | null>(null);

export function McpTaskProvider({
  value,
  children,
}: {
  value: McpTaskContextValue;
  children: ReactNode;
}) {
  return (
    <McpTaskContext.Provider value={value}>{children}</McpTaskContext.Provider>
  );
}

/**
 * The background task backing a tool call, if it has one.
 *
 * Read through context rather than passed down: a tool call is rendered several
 * levels below the message list (group → circle → expanded card), and only the
 * two leaves that show task state need it.
 */
export function useMcpTaskFor(toolCallId: string | undefined): {
  task: McpTaskPartData | undefined;
  cancel: (taskId: string) => void;
  isCancelling: boolean;
} {
  const context = useContext(McpTaskContext);
  const task = toolCallId ? context?.byToolCallId.get(toolCallId) : undefined;
  return {
    task,
    cancel: context?.cancel ?? noop,
    isCancelling: Boolean(task && context?.cancellingTaskId === task.taskId),
  };
}

function noop() {}
