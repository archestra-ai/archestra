import {
  TOOL_CANCEL_TASK_SHORT_NAME,
  TOOL_GET_TASK_SHORT_NAME,
  TOOL_LIST_TASKS_SHORT_NAME,
  TOOL_START_TASK_SHORT_NAME,
  TOOL_STEER_TASK_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import { watchChatOpsTask } from "@/agents/chatops/chatops-task-watcher";
import { userHasPermission } from "@/auth/utils";
import config from "@/config";
import logger from "@/logging";
import {
  A2AArtifactModel,
  A2ATaskModel,
  AgentModel,
  AgentRunModel,
  AgentTeamModel,
} from "@/models";
import { RouteCategory } from "@/observability/tracing";
import { resolveRunnerBackend } from "@/services/runners/backends";
import { preflightAgentDeploymentCredentials } from "@/services/runners/credentials";
import { resolveAgentDeployment } from "@/services/runners/pod-execution";
import {
  cancelDetachedAgentTask,
  startDetachedAgentTask,
} from "@/services/runners/start-task";
import { AGENT_DEPLOYMENT_CREDENTIALS_REQUIRED_CODE } from "@/types";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

/**
 * Start a durable delegated task through the same lifecycle used by the MCP
 * task tool. Agent delegation uses this when the target has Background
 * execution configured, so every delegation surface selects the same runtime.
 */
export async function startDelegatedTask(params: {
  agentId: string;
  message: string;
  context: ArchestraContext;
}) {
  const { agentId, message, context } = params;
  try {
    const actor = requireActor(context);
    const agent = await AgentModel.findById(agentId);
    if (!agent || agent.organizationId !== actor.organizationId) {
      return errorResult("Agent not found");
    }
    const isAgentAdmin = await userHasPermission(
      actor.id,
      actor.organizationId,
      "agent",
      "admin",
    );
    if (
      !(await AgentTeamModel.userHasAgentAccess(
        actor.id,
        agent.id,
        isAgentAdmin,
        agent,
      ))
    ) {
      return errorResult("Agent not found");
    }

    const deployment = resolveAgentDeployment(agent);
    if (deployment) resolveRunnerBackend(deployment.backend);

    // Refuse before creating a task when the caller can already fix the
    // missing credential. Otherwise the detached task fails after its handle
    // has been returned and the user only discovers the problem by polling.
    if (deployment) {
      const preflight = await preflightAgentDeploymentCredentials({
        deployment,
        organizationId: actor.organizationId,
        userId: actor.id,
      });
      if (preflight.missing.length > 0) {
        return credentialsNeededResult(agent.id, preflight.missing);
      }
      if (preflight.misconfigured.length > 0) {
        return errorResult(
          `Agent "${agent.name}" is missing shared Background execution credentials an administrator must configure: ${preflight.misconfigured
            .map((entry) => entry.label)
            .join(", ")}`,
        );
      }
    }

    const completionTarget =
      context.chatOpsBindingId && context.chatOpsThreadId
        ? {
            type: "chatops" as const,
            bindingId: context.chatOpsBindingId,
            threadId: context.chatOpsThreadId,
          }
        : undefined;
    const taskRow = await startDetachedAgentTask({
      actor,
      agentId: agent.id,
      message,
      systemParams: {
        sessionId:
          context.sessionId || context.conversationId || context.isolationKey,
        routeCategory: completionTarget
          ? RouteCategory.CHATOPS
          : RouteCategory.A2A,
        completionTarget,
      },
    });

    // Work started from a chat thread reports back to that thread when it
    // settles. The callback coordinates are also persisted on the Agent run,
    // so the reconciler can recover delivery after a restart.
    if (context.chatOpsBindingId && context.chatOpsThreadId) {
      void watchChatOpsTask({
        taskId: taskRow.id,
        bindingId: context.chatOpsBindingId,
        threadId: context.chatOpsThreadId,
        agentName: agent.name,
      }).catch((error) => {
        logger.warn(
          { error, taskId: taskRow.id },
          "Failed to watch Agent task for messaging-channel completion",
        );
      });
    }

    return structuredSuccessResult(
      {
        task: taskRowSummary(taskRow),
        execution: deployment ? "background" : "foreground",
      },
      `Task ${taskRow.id} started on ${agent.name}` +
        (deployment ? " (Background execution)" : " (foreground)") +
        ". Poll get_task for progress.",
    );
  } catch (error) {
    const needed = missingCredentialsFrom(error);
    if (needed) {
      return credentialsNeededResult(needed.agentId, needed.missing);
    }
    return catchError(error, "starting the task");
  }
}

/**
 * The MCP face of the A2A task lifecycle: start long-running work on another
 * agent, then observe, steer and cancel it — the same durable machinery the
 * A2A v2 protocol drives, so a client speaking either surface sees the same
 * tasks in the same states.
 *
 * When the target Agent has Background execution configured, delegated work
 * runs in its deployment; otherwise it runs in-process. This task interface is
 * independent of foreground message handling.
 */

const TaskSummarySchema = z.object({
  task_id: z.string().describe("Pass to get_task / steer_task / cancel_task."),
  state: z
    .string()
    .describe(
      "submitted | working | input-required | completed | canceled | failed",
    ),
  agent_id: z.string().nullable().describe("The agent doing the work."),
  status_reason: z
    .string()
    .nullable()
    .describe("Why the task is in its state, when there is something to say."),
  created_at: z.string().describe("ISO 8601."),
  state_changed_at: z.string().describe("ISO 8601 of the last transition."),
});

const StartTaskOutputSchema = z.object({
  task: TaskSummarySchema,
  execution: z
    .enum(["background", "foreground"])
    .describe("Where the delegated task executes."),
});

const GetTaskOutputSchema = z.object({
  task: TaskSummarySchema,
  output: z
    .string()
    .describe("The task's response artifact so far (tail, capped)."),
  output_truncated: z.boolean(),
  session: z
    .object({
      attachable: z
        .boolean()
        .describe("Whether a live container is carrying the task right now."),
      started_at: z.string().nullable(),
    })
    .nullable()
    .describe("The Agent run, when the task uses Background execution."),
});

const ListTasksOutputSchema = z.object({
  tasks: z.array(TaskSummarySchema),
  total: z.number().int().nonnegative(),
});

/** How much artifact text get_task inlines; the tail is the useful end. */
const MAX_INLINED_OUTPUT_CHARS = 20_000;
const MAX_LISTED_TASKS = 50;

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_START_TASK_SHORT_NAME,
    title: "Start Task",
    description:
      "Start long-running work on an agent as a durable task and return immediately with its id. " +
      "If the Agent has Background execution configured, the work executes in its deployment. " +
      "Poll get_task for progress, steer_task to interject, cancel_task to stop.",
    schema: z.object({
      agent_id: z.string().describe("The agent to do the work."),
      message: z
        .string()
        .trim()
        .min(1, "message is required.")
        .describe("What the agent should do."),
    }),
    outputSchema: StartTaskOutputSchema,
    handler: ({ args, context }) =>
      startDelegatedTask({
        agentId: args.agent_id,
        message: args.message,
        context,
      }),
  }),

  defineArchestraTool({
    shortName: TOOL_GET_TASK_SHORT_NAME,
    title: "Get Task",
    description:
      "Read a task's state and the output it has produced so far. " +
      "A task in state 'working' is still going — poll again rather than assuming it stalled.",
    schema: z.object({
      task_id: z.string().uuid().describe("From start_task or list_tasks."),
    }),
    outputSchema: GetTaskOutputSchema,
    handler: async ({ args, context }) => {
      try {
        const actor = requireActor(context);
        const task = await requireAccessibleTask(args.task_id, actor);
        if ("error" in task) return errorResult(task.error);

        const artifacts = await A2AArtifactModel.findByTaskId(task.row.id);
        const text = artifacts
          .flatMap((artifact) =>
            Array.isArray(artifact.parts) ? artifact.parts : [],
          )
          .map((part) =>
            typeof (part as { text?: unknown }).text === "string"
              ? (part as { text: string }).text
              : "",
          )
          .join("");
        const truncated = text.length > MAX_INLINED_OUTPUT_CHARS;

        const session = await AgentRunModel.findByTaskId(task.row.id);

        return structuredSuccessResult(
          {
            task: taskRowSummary(task.row),
            // The tail: the newest output is what a poller wants to see.
            output: truncated ? text.slice(-MAX_INLINED_OUTPUT_CHARS) : text,
            output_truncated: truncated,
            session: session
              ? {
                  attachable: session.endedAt === null,
                  started_at: session.startedAt?.toISOString() ?? null,
                }
              : null,
          },
          `Task ${task.row.id}: ${task.row.state}`,
        );
      } catch (error) {
        return catchError(error, "reading the task");
      }
    },
  }),

  defineArchestraTool({
    shortName: TOOL_LIST_TASKS_SHORT_NAME,
    title: "List Tasks",
    description: "List your tasks on one agent, newest activity first.",
    schema: z.object({
      agent_id: z.string().describe("The agent whose tasks to list."),
      state: z
        .enum([
          "submitted",
          "working",
          "input-required",
          "completed",
          "canceled",
          "failed",
        ])
        .optional()
        .describe("Only tasks in this state."),
    }),
    outputSchema: ListTasksOutputSchema,
    handler: async ({ args, context }) => {
      try {
        const actor = requireActor(context);
        const { tasks, totalSize } = await A2ATaskModel.listForActor({
          actorKind: actor.kind,
          actorId: actor.id,
          agentId: args.agent_id,
          state: args.state
            ? FRIENDLY_TO_PROTOCOL_STATE[args.state]
            : undefined,
          pageSize: MAX_LISTED_TASKS,
        });
        return structuredSuccessResult(
          { tasks: tasks.map(taskRowSummary), total: totalSize },
          `${totalSize} task(s)`,
        );
      } catch (error) {
        return catchError(error, "listing tasks");
      }
    },
  }),

  defineArchestraTool({
    shortName: TOOL_STEER_TASK_SHORT_NAME,
    title: "Steer Task",
    description:
      "Interject one message into a running task's container session — a course correction " +
      "without stopping the work. Only tasks using Background execution can be steered.",
    schema: z.object({
      task_id: z.string().uuid(),
      message: z.string().trim().min(1, "message is required."),
    }),
    handler: async ({ args, context }) => {
      try {
        const actor = requireActor(context);
        const task = await requireAccessibleTask(args.task_id, actor);
        if ("error" in task) return errorResult(task.error);

        const session = await AgentRunModel.findByTaskId(task.row.id);
        if (!session || session.endedAt !== null) {
          return errorResult(
            "This task has no live container session to steer. In-process tasks cannot be steered; finished ones no longer listen.",
          );
        }
        // Narrower than task access on purpose: steering types into a shell
        // holding that person's own credentials.
        if (session.actorUserId !== actor.id) {
          return errorResult(
            "Only the person the execution acts as can steer it.",
          );
        }
        const agent = await AgentModel.findById(session.agentId);
        const deployment = agent ? resolveAgentDeployment(agent) : null;
        if (!deployment) {
          return errorResult(
            "The Agent no longer has Background execution configured.",
          );
        }

        await resolveRunnerBackend(session.backend).steer({
          session,
          steerMode: deployment.steerMode,
          message: args.message,
        });
        return structuredSuccessResult(
          { success: true, task_id: task.row.id },
          "Steer delivered. It lands at the loop's next turn boundary (pipe) or is typed into the session (tmux keys).",
        );
      } catch (error) {
        return catchError(error, "steering the task");
      }
    },
  }),

  defineArchestraTool({
    shortName: TOOL_CANCEL_TASK_SHORT_NAME,
    title: "Cancel Task",
    description:
      "Durably cancel a task. A container session carrying it is torn down.",
    schema: z.object({
      task_id: z.string().uuid(),
    }),
    handler: async ({ args, context }) => {
      try {
        const actor = requireActor(context);
        const task = await requireAccessibleTask(args.task_id, actor);
        if ("error" in task) return errorResult(task.error);
        if (!task.row.agentId) {
          return errorResult("This task has no agent to cancel against.");
        }

        const canceled = await cancelDetachedAgentTask({
          actor,
          agentId: task.row.agentId,
          taskId: task.row.id,
        });
        const canceledRow = await A2ATaskModel.findById(task.row.id);
        if (!canceledRow) {
          throw new Error("Canceled task was not persisted");
        }
        return structuredSuccessResult(
          {
            task: taskRowSummary(canceledRow),
          },
          `Task ${task.row.id}: ${describeProtocolState(canceled)}`,
        );
      } catch (error) {
        return catchError(error, "canceling the task");
      }
    },
  }),
]);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

// === Internal helpers ===

/**
 * The refusal as a prompt: the exact keys still needed, and a deep link into
 * the platform where this person deposits them.
 */
function credentialsNeededResult(
  agentId: string,
  missing: Array<{ key: string; label: string; description?: string }>,
) {
  const url = `${config.frontendBaseUrl}/agents/${agentId}?tab=overview#background-execution-credentials`;
  return errorResult(
    `This Agent's Background execution needs credentials you have not set up yet:\n${missing
      .map(
        (entry) =>
          `- ${entry.label} (${entry.key})${entry.description ? `: ${entry.description}` : ""}`,
      )
      .join(
        "\n",
      )}\n\nAsk the user to add them here, then start the task again: ${url}`,
  );
}

/** The missing-credential list when the error is that refusal; null otherwise. */
function missingCredentialsFrom(error: unknown): {
  agentId: string;
  missing: Array<{ key: string; label: string; description?: string }>;
} | null {
  if (
    error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code ===
      AGENT_DEPLOYMENT_CREDENTIALS_REQUIRED_CODE &&
    typeof (error as { agentId?: unknown }).agentId === "string" &&
    Array.isArray((error as { missing?: unknown }).missing)
  ) {
    return error as {
      agentId: string;
      missing: Array<{ key: string; label: string; description?: string }>;
    };
  }
  return null;
}

function requireActor(context: ArchestraContext): A2AActor {
  if (!context.userId || !context.organizationId) {
    throw new Error(
      "Task tools act as the calling user, so they need an authenticated user context.",
    );
  }
  return {
    id: context.userId,
    kind: "user",
    organizationId: context.organizationId,
  };
}

/**
 * A task the caller may see: their own, or any in their organization when they
 * hold agent:admin. Missing and inaccessible return the same message so task
 * ids cannot be probed.
 */
async function requireAccessibleTask(
  taskId: string,
  actor: A2AActor,
): Promise<
  | { row: Awaited<ReturnType<typeof A2ATaskModel.findById>> & object }
  | { error: string }
> {
  const notFound = { error: "Task not found" };
  const row = await A2ATaskModel.findById(taskId);
  if (!row) return notFound;

  // Contexts carry no organization; the task's agent does. A task without an
  // agent is only ever visible to its own actor.
  if (row.agentId) {
    const agent = await AgentModel.findById(row.agentId);
    if (!agent || agent.organizationId !== actor.organizationId) {
      return notFound;
    }
  }

  const context = await A2ATaskModel.findActorForTask(taskId);
  const isOwn =
    context !== null &&
    context.actorKind === actor.kind &&
    context.actorId === actor.id;
  if (!isOwn) {
    const isAdmin =
      row.agentId !== null &&
      (await userHasPermission(
        actor.id,
        actor.organizationId,
        "agent",
        "admin",
      ));
    if (!isAdmin) return notFound;
  }
  return { row };
}

function taskRowSummary(row: {
  id: string;
  state: string;
  agentId: string | null;
  statusReason?: string | null;
  createdAt: Date;
  stateChangedAt: Date | null;
}) {
  return {
    task_id: row.id,
    state: displayState(row.state),
    agent_id: row.agentId,
    status_reason: row.statusReason ?? null,
    created_at: row.createdAt.toISOString(),
    state_changed_at: (row.stateChangedAt ?? row.createdAt).toISOString(),
  };
}

function describeProtocolState(task: { status: { state?: string } }): string {
  return displayState(task.status.state);
}

/** "TASK_STATE_INPUT_REQUIRED" → "input-required"; unknown values pass through. */
function displayState(state: string | undefined): string {
  if (!state) return "unknown";
  return state
    .replace(/^TASK_STATE_/, "")
    .toLowerCase()
    .replaceAll("_", "-");
}

const FRIENDLY_TO_PROTOCOL_STATE = {
  submitted: "TASK_STATE_SUBMITTED",
  working: "TASK_STATE_WORKING",
  "input-required": "TASK_STATE_INPUT_REQUIRED",
  completed: "TASK_STATE_COMPLETED",
  canceled: "TASK_STATE_CANCELED",
  failed: "TASK_STATE_FAILED",
} as const;
