import {
  TOOL_CANCEL_BACKGROUND_TASK_SHORT_NAME,
  TOOL_LIST_BACKGROUND_TASKS_SHORT_NAME,
  TOOL_TODO_WRITE_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import logger from "@/logging";
import McpGatewayTaskModel from "@/models/mcp-gateway-task";
import { mcpGatewayTaskRunner } from "@/routes/mcp-gateway/tasks";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

// === Constants ===

const TodoItemSchema = z
  .object({
    id: z.number().int().describe("Unique identifier for the todo item."),
    content: z
      .string()
      .describe("The content or description of the todo item."),
    status: z
      .enum(["pending", "in_progress", "completed"])
      .describe("The current status of the todo item."),
  })
  .strict();

const TodoWriteOutputSchema = z.object({
  success: z.literal(true).describe("Whether the write succeeded."),
  todoCount: z
    .number()
    .int()
    .nonnegative()
    .describe("How many todo items were written."),
});

const BackgroundTaskSchema = z.object({
  taskId: z
    .string()
    .describe("The task's id (usable with cancel_background_task)."),
  status: z
    .enum(["working", "completed", "failed", "cancelled"])
    .describe("Current task status."),
  kind: z
    .enum(["delegation", "skill"])
    .describe("What spawned the task: an agent delegation or a skill run."),
  agentName: z.string().describe("The subagent the task runs on."),
  toolName: z.string().describe("The delegation tool that spawned the task."),
  startedAt: z.string().describe("When the task started (ISO timestamp)."),
  settledAt: z
    .string()
    .nullable()
    .describe("When the task settled, or null while still working."),
});

const ListBackgroundTasksOutputSchema = z.object({
  tasks: z
    .array(BackgroundTaskSchema)
    .describe("This conversation's background tasks, newest first."),
});

const CancelBackgroundTaskOutputSchema = z.object({
  cancelled: z
    .boolean()
    .describe(
      "True when this call cancelled the task; false when there was nothing to cancel (already settled, unknown, or not yours).",
    ),
});

/**
 * Background-task tools operate on the caller's own tasks in the current
 * conversation: the `(conversation, principal)` scoping in the model IS the
 * authorization, identical to `POST /api/chat/tasks/:taskId/cancel`.
 */
function resolveBackgroundTaskCaller(
  context: ArchestraContext,
):
  | { conversationId: string; principal: string }
  | { error: ReturnType<typeof errorResult> } {
  const userId = context.userId ?? context.tokenAuth?.userId;
  if (!context.conversationId || !userId || userId === "system") {
    return {
      error: errorResult(
        "Background tasks exist only in interactive chat conversations.",
      ),
    };
  }
  return {
    conversationId: context.conversationId,
    principal: `user:${userId}`,
  };
}

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_TODO_WRITE_SHORT_NAME,
    title: "Write Todos",
    description:
      "Write todos to the current conversation. You have access to this tool to help you manage and plan tasks. Use it VERY frequently to ensure that you are tracking your tasks and giving the user visibility into your progress. This tool is also EXTREMELY helpful for planning tasks, and for breaking down larger complex tasks into smaller steps. If you do not use this tool when planning, you may forget to do important tasks - and that is unacceptable. It is critical that you mark todos as completed as soon as you are done with a task. Do not batch up multiple tasks before marking them as completed.",
    schema: z
      .object({
        todos: z
          .array(TodoItemSchema)
          .describe("Array of todo items to write to the conversation."),
      })
      .strict(),
    outputSchema: TodoWriteOutputSchema,
    async handler({ args, context }) {
      const { agent: contextAgent } = context;

      logger.info(
        { agentId: contextAgent.id, todoArgs: args },
        "todo_write tool called",
      );

      try {
        return structuredSuccessResult(
          { success: true, todoCount: args.todos.length },
          `Successfully wrote ${args.todos.length} todo item(s) to the conversation`,
        );
      } catch (error) {
        return catchError(error, "writing todos");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_LIST_BACKGROUND_TASKS_SHORT_NAME,
    title: "List Background Tasks",
    description:
      "List this conversation's background tasks (delegations or skill runs started with background: true): their status, which subagent runs them, and when they started or settled. Use it to check on work you kicked off — never poll it in a loop; results arrive on their own as notification messages.",
    schema: z.object({}).strict(),
    outputSchema: ListBackgroundTasksOutputSchema,
    async handler({ context }) {
      const caller = resolveBackgroundTaskCaller(context);
      if ("error" in caller) return caller.error;
      try {
        const rows = await McpGatewayTaskModel.listForConversation({
          conversationId: caller.conversationId,
          principal: caller.principal,
        });
        const tasks = rows
          .filter((row) => row.context !== null)
          .map((row) => ({
            taskId: row.id,
            status: row.status,
            kind: row.context?.kind ?? ("delegation" as const),
            agentName: row.context?.targetAgentName ?? "unknown",
            toolName: row.toolName,
            startedAt: row.createdAt.toISOString(),
            settledAt:
              row.status === "working" ? null : row.updatedAt.toISOString(),
          }));
        return structuredSuccessResult(
          { tasks },
          tasks.length === 0
            ? "No background tasks in this conversation."
            : `${tasks.length} background task(s).`,
        );
      } catch (error) {
        return catchError(error, "listing background tasks");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_CANCEL_BACKGROUND_TASK_SHORT_NAME,
    title: "Cancel Background Task",
    description:
      "Cancel one of this conversation's still-running background tasks by taskId (from the spawn confirmation or list_background_tasks). Cancelling is final: no notification message will arrive for a cancelled task.",
    schema: z
      .object({
        taskId: z.string().describe("Id of the background task to cancel."),
      })
      .strict(),
    outputSchema: CancelBackgroundTaskOutputSchema,
    async handler({ args, context }) {
      const caller = resolveBackgroundTaskCaller(context);
      if ("error" in caller) return caller.error;
      try {
        const cancelled = await McpGatewayTaskModel.cancelForPrincipal({
          taskId: args.taskId,
          principal: caller.principal,
          // Scope to the current conversation, matching the tool's contract
          // (and list_background_tasks' visibility).
          conversationId: caller.conversationId,
        });
        if (cancelled) {
          // Abort the in-process execution when it runs on this replica; on
          // any other replica the run keeps going until its own settle write
          // loses to the cancelled status.
          mcpGatewayTaskRunner.abort(args.taskId);
        }
        return structuredSuccessResult(
          { cancelled },
          cancelled
            ? "Background task cancelled."
            : "Nothing to cancel — the task already settled, does not exist, or is not yours.",
        );
      } catch (error) {
        return catchError(error, "cancelling a background task");
      }
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;

// === Exports ===

export const tools = registry.tools;
