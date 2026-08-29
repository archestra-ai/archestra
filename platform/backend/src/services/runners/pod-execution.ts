import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { DEFAULT_APP_NAME, toPlaceholderTitle } from "@archestra/shared";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import type { A2AExecuteResult } from "@/agents/a2a-executor";
import config from "@/config";
import logger from "@/logging";
import {
  AgentExecutionInputModel,
  AgentRunModel,
  EnvironmentModel,
  OrganizationModel,
} from "@/models";
import {
  reportRunnerProvisioned,
  reportRunnerStarted,
  reportRunnerTerminated,
} from "@/observability/metrics/runner";
import { resolveEffectiveNetworkPolicy } from "@/services/environments/network-policy";
import type {
  Agent,
  AgentDeployment,
  AgentRun,
  AgentRunCompletionTarget,
} from "@/types";
import { ApiError } from "@/types";
import { type RunnerBackend, resolveRunnerBackend } from "./backends";
import { buildRunnerLaunchSpec } from "./launch-spec";
import { generateAgentExecutionTitle } from "./title";

/**
 * Start one delegated A2A task through its configured execution backend.
 *
 * This is the `executeRun` the A2A task lifecycle already injects, swapped for
 * an isolated execution-backed one. Everything above it — the compare-and-set state
 * machine, the response artifact, the durable event log, cancellation, push
 * notifications and SSE subscribers — is unchanged, because the lifecycle only
 * ever knew that contract.
 *
 * The session is started and then followed: its stdout becomes the task's
 * streamed text, and abort tears the execution down.
 */
async function startBackgroundSession(params: {
  deployment: AgentDeployment;
  taskId: string;
  agentId: string;
  actor: A2AActor;
  organizationId: string;
  completionTarget?: AgentRunCompletionTarget;
  task?: string | null;
  executionMode: "interactive" | "one_shot";
  modelId: string | null;
  llmApiKeyId: string | null;
  titleUserId?: string;
}): Promise<AgentRun> {
  const backend = resolveRunnerBackend(params.deployment.backend);

  const environment = params.deployment.environmentId
    ? await EnvironmentModel.findByIdForOrganization(
        params.deployment.environmentId,
        params.organizationId,
      )
    : null;
  const organization = await OrganizationModel.getById(params.organizationId);
  const runtimeScope = backend.resolveRuntimeScope({
    environmentScope: environment?.namespace,
    organizationScope: organization?.defaultEnvironmentNamespace,
  });
  const effectiveNetworkPolicy = await resolveEffectiveNetworkPolicy({
    organizationId: params.organizationId,
    environmentId: params.deployment.environmentId,
    environmentNetworkPolicy: environment?.networkPolicy,
    defaultNetworkPolicy: organization?.defaultNetworkPolicy,
  });
  const inputFiles = await AgentExecutionInputModel.findByTaskId(params.taskId);

  const { spec, virtualApiKeyId } = await buildRunnerLaunchSpec({
    deployment: params.deployment,
    taskId: params.taskId,
    agentId: params.agentId,
    actor: params.actor,
    organizationId: params.organizationId,
    runtimeScope,
    effectiveNetworkPolicy,
    appName: organization?.appName ?? DEFAULT_APP_NAME,
    task: params.task,
    executionMode: params.executionMode,
    inputFiles,
  });

  // The row lands before the workload: it is what teardown reads to find the
  // objects, so a crash between the two must leave a record, not an orphan.
  const placeholderTitle = toPlaceholderTitle(params.task ?? "Execution");
  const session = await AgentRunModel.create({
    organizationId: params.organizationId,
    taskId: params.taskId,
    agentId: params.deployment.agentId,
    actorKind: params.actor.kind,
    actorId: params.actor.id,
    actorUserId: params.actor.kind === "user" ? params.actor.id : null,
    title: placeholderTitle,
    deploymentName: spec.frozenName,
    backend: backend.name,
    runtimeScope,
    virtualApiKeyId,
    completionTarget: params.completionTarget,
  });

  void generateAgentExecutionTitle({
    taskId: params.taskId,
    prompt: params.task ?? "Execution",
    organizationId: params.organizationId,
    userId: params.titleUserId,
    modelId: params.modelId,
    llmApiKeyId: params.llmApiKeyId,
  })
    .then((title) =>
      AgentRunModel.updateTitleIfCurrent({
        taskId: params.taskId,
        expectedTitle: placeholderTitle,
        title,
      }),
    )
    .catch((error) => {
      logger.warn(
        { error, taskId: params.taskId },
        "Could not generate an Agent execution title",
      );
    });

  try {
    await backend.launch(spec);
    await backend.stageInputs({ session, inputs: inputFiles });
  } catch (error) {
    // Nothing was scheduled, but a Secret holding the actor's personal
    // credentials may already exist. Close the session so the reconciler does
    // not adopt it, and remove whatever landed.
    await backend.teardown(session).catch((teardownError) => {
      logger.warn(
        { error: teardownError, sessionId: session.id },
        "Teardown after a failed runner launch did not complete",
      );
    });
    await AgentRunModel.close({ id: session.id }).catch((error) => {
      logger.warn(
        { error, sessionId: session.id, taskId: session.taskId },
        "Could not mark the Agent run as ended",
      );
    });
    throw error;
  }

  return session;
}

/** Runtime-ready deployment for an Agent that opted into background execution. */
export function resolveAgentDeployment(
  agent: Pick<
    Agent,
    | "id"
    | "organizationId"
    | "environmentId"
    | "backgroundExecution"
    | "backgroundExecutionSecretId"
  >,
): AgentDeployment | null {
  if (!config.agentBackgroundExecution.enabled || !agent.backgroundExecution) {
    return null;
  }
  return {
    ...agent.backgroundExecution,
    agentId: agent.id,
    organizationId: agent.organizationId,
    environmentId: agent.environmentId,
    secretId: agent.backgroundExecutionSecretId,
  };
}

/**
 * Run one delegated A2A task to completion, shaped as the lifecycle's
 * `executeRun`.
 *
 * Ordering matters here. The execution is started, then followed, then waited
 * on. A backend outcome rather than the log stream ends the task because an
 * output connection can stop before the workload does. Teardown runs in a
 * finally so a crash, cancellation and a clean finish all release the runtime,
 * the actor's injected credentials, and the minted virtual key.
 */
export async function runTaskInBackground(params: {
  deployment: AgentDeployment;
  taskId: string;
  agentId: string;
  actor: A2AActor;
  organizationId: string;
  completionTarget?: AgentRunCompletionTarget;
  task?: string | null;
  executionMode: "interactive" | "one_shot";
  modelId: string | null;
  llmApiKeyId: string | null;
  titleUserId?: string;
  onTextDelta?: (delta: string) => void;
  abortSignal?: AbortSignal;
}): Promise<A2AExecuteResult> {
  const launchedAt = Date.now();
  const session = await startBackgroundSession(params);
  return await followBackgroundTask({
    session,
    launchedAt,
    onTextDelta: params.onTextDelta,
    abortSignal: params.abortSignal,
  });
}

/**
 * Re-attach the durable A2A lifecycle to an execution that survived a control
 * plane restart. Its original backend owns the work; this process resumes output capture,
 * heartbeats and terminal settlement without launching a second workload.
 */
export async function resumeBackgroundTask(params: {
  session: AgentRun;
  onTextDelta?: (delta: string) => void;
  abortSignal?: AbortSignal;
}): Promise<A2AExecuteResult> {
  return await followBackgroundTask({
    session: params.session,
    onTextDelta: params.onTextDelta,
    abortSignal: params.abortSignal,
  });
}

/** Clean up a session whose task settled while no backend owned its run. */
export async function cleanupBackgroundTask(session: AgentRun): Promise<void> {
  const backend = resolveRunnerBackend(session.backend);
  let retainedLogs = "";
  const stopCapture = new AbortController();
  const capture = followOutput({
    backend,
    session,
    abortSignal: stopCapture.signal,
    onChunk: (chunk) => {
      retainedLogs = retainLogTail(retainedLogs, chunk);
    },
  });
  await Promise.race([capture, delayMs(LOG_DRAIN_GRACE_MS)]);
  stopCapture.abort();
  await backend.teardown(session);
  await AgentRunModel.close({ id: session.id, logs: retainedLogs });
}

async function followBackgroundTask(params: {
  session: AgentRun;
  launchedAt?: number;
  onTextDelta?: (delta: string) => void;
  abortSignal?: AbortSignal;
}): Promise<A2AExecuteResult> {
  const backend = resolveRunnerBackend(params.session.backend);
  const { session } = params;
  const transcript: string[] = [];
  let retainedLogs = "";
  let outcome: "succeeded" | "failed" | "aborted" = "failed";

  try {
    await backend.waitUntilRunning({
      session,
      abortSignal: params.abortSignal,
    });
    // Measured from the launch call rather than from the session row, so the
    // number answers "how long until this could do work" — image pull and
    // scheduling included, which is where the time actually goes.
    if (params.launchedAt !== undefined) {
      reportRunnerProvisioned((Date.now() - params.launchedAt) / 1000);
    }
    reportRunnerStarted();

    // Logs are followed on their own promise: the backend outcome ends the
    // run, and a stream that dies early (runtime replaced, connection dropped)
    // must not be mistaken for the task finishing.
    const streaming = followOutput({
      backend,
      session,
      abortSignal: params.abortSignal,
      onChunk: (chunk) => {
        transcript.push(chunk);
        retainedLogs = retainLogTail(retainedLogs, chunk);
        params.onTextDelta?.(chunk);
      },
    });

    const completion = await backend.waitForCompletion({
      session,
      abortSignal: params.abortSignal,
    });
    outcome = completion.outcome;

    // Give the tail of the log a moment to arrive before settling: the last
    // write and the backend's outcome race, and dropping it would truncate
    // the answer at exactly the point the reader cares about.
    await Promise.race([streaming, delayMs(LOG_DRAIN_GRACE_MS)]);

    const text = transcript.join("");

    if (completion.outcome === "failed") {
      throw new ApiError(
        502,
        completion.reason ?? "The background run exited without completing",
      );
    }

    return {
      messageId: randomUUID(),
      text,
      // An aborted run still returns what it produced; the lifecycle above
      // records the cancellation, so reporting "stop" here would overwrite a
      // more specific outcome with a less specific one.
      finishReason: completion.outcome === "aborted" ? "abort" : "stop",
      responseUiMessage: {
        id: randomUUID(),
        role: "assistant",
        parts: [{ type: "text", text }],
      },
    };
  } finally {
    // The metric's label vocabulary predates this path and dashboards key on
    // it, so the run's outcome is mapped onto it rather than widened.
    reportRunnerTerminated(
      outcome === "succeeded"
        ? "completed"
        : outcome === "aborted"
          ? "stopped_by_user"
          : "failed",
    );
    await backend.teardown(session).catch((error) => {
      logger.warn(
        { error, sessionId: session.id, taskId: session.taskId },
        "Runner session teardown did not complete",
      );
    });
    await AgentRunModel.close({ id: session.id, logs: retainedLogs }).catch(
      (error) => {
        logger.warn(
          { error, sessionId: session.id, taskId: session.taskId },
          "Could not mark the Agent run as ended",
        );
      },
    );
  }
}

/** Forward the session's output to `onChunk`, resolving when the stream ends. */
function followOutput(params: {
  backend: RunnerBackend;
  session: AgentRun;
  abortSignal?: AbortSignal;
  onChunk: (chunk: string) => void;
}): Promise<void> {
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      params.onChunk(chunk.toString("utf8"));
      callback();
    },
  });

  return new Promise<void>((resolve) => {
    destination.on("finish", resolve);
    destination.on("close", resolve);
    destination.on("error", resolve);
    params.backend
      .streamOutput({
        session: params.session,
        destination,
        abortSignal: params.abortSignal,
      })
      .catch((error) => {
        // A run whose logs cannot be followed still runs; the transcript is
        // poorer, but ending the task over it would be worse.
        logger.warn(
          { error, sessionId: params.session.id },
          "Could not follow runner logs; the task continues without streamed output",
        );
        destination.destroy();
        resolve();
      });
  });
}

function delayMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

const LOG_DRAIN_GRACE_MS = 2_000;
const RETAINED_LOG_BYTES = 1024 * 1024;

function retainLogTail(current: string, chunk: string): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, "utf8") <= RETAINED_LOG_BYTES) {
    return combined;
  }
  return Buffer.from(combined, "utf8")
    .subarray(-RETAINED_LOG_BYTES)
    .toString("utf8")
    .replace(/^\uFFFD/, "");
}
