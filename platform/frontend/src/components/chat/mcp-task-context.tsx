"use client";

import type { McpTaskPartData } from "@archestra/shared";
import { createContext, type ReactNode, useContext } from "react";

interface McpTaskContextValue {
  /** Background tasks for this conversation, keyed by the tool call they back. */
  byToolCallId: Map<string, McpTaskPartData>;
  cancel: (taskId: string) => void;
  /**
   * Tasks a cancel has been requested for. Held until the task actually leaves
   * `working` rather than until the request resolves: the endpoint answers well
   * before the next poll flips the row, and re-enabling in that gap makes the
   * button flash and invites a second click.
   */
  cancelRequestedTaskIds: ReadonlySet<string>;
  /**
   * Tool calls that wait for a free place on their server before they start.
   * A server runs a few calls at a time, so the rest of a large batch waits.
   */
  queuedToolCallIds?: ReadonlySet<string>;
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
  /** The call waits for its turn on its server; it has not started yet. */
  isQueued: boolean;
} {
  const context = useContext(McpTaskContext);
  const task = toolCallId ? context?.byToolCallId.get(toolCallId) : undefined;
  return {
    task,
    isQueued: Boolean(
      toolCallId && context?.queuedToolCallIds?.has(toolCallId),
    ),
    cancel: context?.cancel ?? noop,
    isCancelling: Boolean(
      task && context?.cancelRequestedTaskIds.has(task.taskId),
    ),
  };
}

function noop() {}
