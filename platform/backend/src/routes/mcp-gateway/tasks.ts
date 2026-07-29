import config from "@/config";
import logger from "@/logging";
import { McpGatewayTaskModel } from "@/models";
import type { McpGatewayTask } from "@/types/mcp-gateway-task";
import { COMPLETE_RESULT_TYPE } from "./protocol";

/**
 * MCP Tasks extension (`io.modelcontextprotocol/tasks`) at the gateway.
 *
 * The gateway sits between clients and upstream servers, so its task story is
 * an intermediary's: it does not know in advance which upstream calls are slow,
 * and upstream servers on older revisions cannot mint tasks themselves. So the
 * gateway races every eligible call against a threshold. A call that finishes
 * in time returns its ordinary result — task creation is server-directed, and
 * the server directs "no". A call still running at the threshold is durably
 * recorded as a task, the client gets the handle, and the execution continues
 * on this replica, writing its outcome into the row when it settles. Any
 * replica serves `tasks/get`/`tasks/cancel` from the row.
 *
 * Eligibility requires the client to have declared the extension in this
 * request's `_meta` capabilities — the spec forbids returning a task to a
 * client that did not — so clients that have never heard of tasks keep
 * exactly the blocking behavior they always had.
 */

export const MCP_TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";
export const TASK_RESULT_TYPE = "task";

export const TASK_POLL_INTERVAL_MS = 2_000;
/** How long a task row stays retrievable, and the orphan bound (see schema). */
export const TASK_TTL_MS = 30 * 60 * 1000;

/**
 * How long an eligible call runs synchronously before detaching into a task.
 *
 * Derived from the one existing timeout knob rather than adding a second one:
 * ARCHESTRA_MCP_GATEWAY_TOOL_CALL_TIMEOUT_MS is "how long a synchronous tool
 * call may take", and the task threshold is by definition shorter than that —
 * half of it, capped at 10s so a generous timeout doesn't make task-capable
 * clients wait half a minute before they get a handle.
 */
export function taskSyncThresholdMs(): number {
  return Math.min(10_000, Math.floor(config.mcpGateway.toolCallTimeoutMs / 2));
}

export const TASK_METHODS = new Set([
  "tasks/get",
  "tasks/update",
  "tasks/cancel",
]);

/**
 * Whether this request's client declared the Tasks extension. Per-request by
 * design: capabilities ride `_meta` on every request in 2026-07-28.
 */
export function clientDeclaredTasks(body: unknown): boolean {
  const capabilities =
    readMeta(body)?.["io.modelcontextprotocol/clientCapabilities"];
  if (!isRecord(capabilities)) return false;
  const extensions = capabilities.extensions;
  return isRecord(extensions) && MCP_TASKS_EXTENSION_ID in extensions;
}

export function isTaskMethod(body: unknown): boolean {
  return (
    isRecord(body) &&
    typeof body.method === "string" &&
    TASK_METHODS.has(body.method)
  );
}

/**
 * In-process registry of running executions, so a `tasks/cancel` landing on
 * the origin replica aborts the gateway-side await, releasing its connection
 * slot and settling the execution promise. Whether the upstream server stops
 * WORKING is up to the upstream: verified against a live stateless HTTP
 * upstream, the tool ran to its (discarded) completion — a stateless server
 * has no request to correlate an MCP cancellation with. That is the
 * cooperative cancellation the extension describes: the client and the task
 * row are correct everywhere; upstream compute is best-effort.
 */
class McpGatewayTaskRunner {
  private controllers = new Map<string, AbortController>();

  register(taskId: string, controller: AbortController): void {
    this.controllers.set(taskId, controller);
  }

  release(taskId: string): void {
    this.controllers.delete(taskId);
  }

  abort(taskId: string): boolean {
    const controller = this.controllers.get(taskId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
}

export const mcpGatewayTaskRunner = new McpGatewayTaskRunner();

/**
 * Run a tool call, upgrading it to a task if it outlives the threshold.
 *
 * The row is durably created BEFORE the handle is returned, per the extension
 * — otherwise the client's first poll could race the insert. The detached
 * continuation stores the exact response the call would have returned, so
 * `tasks/get` yields byte-for-byte what a synchronous caller would have seen.
 */
export async function runToolCallMaybeTask(params: {
  eligible: boolean;
  agentId: string;
  principal: string;
  toolName: string;
  execute: (signal: AbortSignal) => Promise<Record<string, unknown>>;
  thresholdMs?: number;
}): Promise<Record<string, unknown>> {
  const {
    eligible,
    agentId,
    principal,
    toolName,
    execute,
    thresholdMs = taskSyncThresholdMs(),
  } = params;

  const controller = new AbortController();
  const execution = execute(controller.signal);

  if (!eligible) return execution;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), thresholdMs);
  });

  const winner = await Promise.race([
    execution.then((result) => ({ result })),
    timeout,
  ]);

  if (winner !== "timeout") {
    clearTimeout(timer);
    return winner.result;
  }

  const task = await McpGatewayTaskModel.create({
    agentId,
    principal,
    toolName,
    ttlMs: TASK_TTL_MS,
  });
  mcpGatewayTaskRunner.register(task.id, controller);

  // Detached continuation: settle the row whichever way the call goes. A
  // result carrying `input_required` means the tool asked for interactive
  // input after the client had already been detached — nobody is there to
  // answer, so the task fails with a reason the client can act on.
  execution
    .then(async (result) => {
      if (result?.resultType === "input_required") {
        await McpGatewayTaskModel.failIfWorking(task.id, {
          code: -32603,
          message:
            "The tool requested interactive input while running as a background task. Re-run it without task mode to answer interactively.",
        });
        return;
      }
      await McpGatewayTaskModel.completeIfWorking(task.id, result);
    })
    .catch(async (error) => {
      await McpGatewayTaskModel.failIfWorking(task.id, {
        code:
          isRecord(error) && typeof error.code === "number"
            ? error.code
            : -32603,
        message: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      mcpGatewayTaskRunner.release(task.id);
    });

  logger.info(
    { agentId, taskId: task.id, toolName, thresholdMs },
    "MCP tool call upgraded to a background task",
  );

  return buildCreateTaskResult(task);
}

/**
 * Serve tasks/get, tasks/update, and tasks/cancel. Every answer is scoped to
 * the calling principal; an unknown, expired, or foreign task id is the same
 * invalid-params error, so ids do not leak across callers.
 */
export async function handleTaskMethod(params: {
  body: unknown;
  agentId: string;
  principal: string;
}): Promise<
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string } }
> {
  const { body, agentId, principal } = params;
  const method = isRecord(body) ? body.method : undefined;
  const bodyParams = isRecord(body) && isRecord(body.params) ? body.params : {};
  const taskId = bodyParams.taskId;

  if (typeof taskId !== "string" || !isUuid(taskId)) {
    return {
      error: { code: -32602, message: "taskId must be a task id string" },
    };
  }

  const task = await McpGatewayTaskModel.getForPrincipal({
    taskId,
    agentId,
    principal,
  });
  if (!task) {
    return { error: { code: -32602, message: `Unknown task: ${taskId}` } };
  }

  switch (method) {
    case "tasks/get":
      return { result: buildTaskState(task) };

    case "tasks/cancel": {
      // Cooperative: abort the running call when it lives here, mark the row
      // regardless, and acknowledge with an empty result per the extension —
      // even when the task already reached a terminal state.
      mcpGatewayTaskRunner.abort(taskId);
      await McpGatewayTaskModel.cancelIfWorking(taskId);
      return { result: { resultType: COMPLETE_RESULT_TYPE } };
    }

    case "tasks/update":
      // The gateway never emits input_required (see runToolCallMaybeTask), so
      // every key is an unknown-or-already-satisfied one, which the extension
      // says to ignore and acknowledge.
      return { result: { resultType: COMPLETE_RESULT_TYPE } };

    default:
      return {
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

function buildCreateTaskResult(task: McpGatewayTask): Record<string, unknown> {
  return {
    resultType: TASK_RESULT_TYPE,
    task: {
      taskId: task.id,
      status: task.status,
      ttlMs: TASK_TTL_MS,
      pollIntervalMs: TASK_POLL_INTERVAL_MS,
      createdAt: task.createdAt.toISOString(),
    },
  };
}

function buildTaskState(task: McpGatewayTask): Record<string, unknown> {
  return {
    resultType: COMPLETE_RESULT_TYPE,
    task: {
      taskId: task.id,
      status: task.status,
      ttlMs: Math.max(0, task.expiresAt.getTime() - Date.now()),
      pollIntervalMs: TASK_POLL_INTERVAL_MS,
      ...(task.status === "completed" &&
        task.result && { result: task.result }),
      ...(task.status === "failed" && task.error && { error: task.error }),
    },
  };
}

function readMeta(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body) || !isRecord(body.params)) return undefined;
  const meta = body.params._meta;
  return isRecord(meta) ? meta : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
