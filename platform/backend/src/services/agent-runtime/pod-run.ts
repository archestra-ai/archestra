import { randomUUID } from "node:crypto";
import {
  DEFAULT_APP_NAME,
  followAgentCatalogImage,
  toPlaceholderTitle,
} from "@archestra/shared";
import type { A2AActor } from "@/agents/a2a/a2a-base";
import { settleFailedA2ATask } from "@/agents/a2a/a2a-task-settlement";
import type { A2AExecuteResult } from "@/agents/a2a-executor";
import config from "@/config";
import {
  describeK8sApiError,
  isK8sNotFoundError,
  isTransientK8sApiError,
} from "@/k8s/shared";
import logger from "@/logging";
import {
  A2ATaskModel,
  AgentModel,
  AgentRunInputModel,
  AgentRunModel,
  AgentWorkspaceModel,
  EnvironmentModel,
  LimitModel,
  OrganizationModel,
} from "@/models";
import {
  reportAgentRuntimeProvisioned,
  reportAgentRuntimeStarted,
  reportAgentRuntimeTerminated,
} from "@/observability/metrics/agent-runtime";
import { resolveEffectiveNetworkPolicy } from "@/services/environments/network-policy";
import type {
  Agent,
  AgentRunCompletionTarget,
  AgentRunRecord,
  ResolvedAgentRuntime,
} from "@/types";
import { ApiError } from "@/types";
import { trackBackgroundWork } from "@/utils/background-work";
import {
  prepareAgentRuntimeBackendDriver,
  resolveAgentRuntimeBackendDriver,
} from "./backends";
import { buildAgentRunLaunchSpec } from "./launch-spec";
import { AgentRuntimeOutputCapture } from "./output-capture";
import {
  agentRunFailure,
  classifyAgentRunFailure,
  tagAgentRunFailure,
} from "./run-failure";
import { constructStableRunName } from "./runtime-contract";
import {
  admitRuntimeSteer,
  bindRuntimeChild,
  promptWithContract,
  type RuntimeCrossing,
} from "./runtime-crossing";
import {
  runtimeOpenAppaSession,
  stampRuntimeBinding,
} from "./runtime-identity";
import { generateAgentRunTitle } from "./title";
import { agentRunTranscriptStore } from "./transcript-store";

/**
 * Start one delegated A2A task through its configured run backend.
 *
 * This is the `executeRun` the A2A task lifecycle already injects, swapped for
 * an isolated run-backed one. Everything above it — the compare-and-set state
 * machine, the response artifact, the durable event log, cancellation, push
 * notifications and SSE subscribers — is unchanged, because the lifecycle only
 * ever knew that contract.
 *
 * The session is started and then followed: its stdout becomes the task's
 * streamed text, and abort tears the run down.
 */
async function startAgentRunSession(params: {
  runtime: ResolvedAgentRuntime;
  taskId: string;
  agentId: string;
  actor: A2AActor;
  organizationId: string;
  projectId?: string | null;
  completionTarget?: AgentRunCompletionTarget;
  onRuntimeSessionCreated?: RuntimeSessionCreatedCallback;
  task?: string | null;
  title?: string;
  runMode: "interactive" | "one_shot";
  modelId: string | null;
  llmApiKeyId: string | null;
  titleUserId?: string;
  resumeFromTaskId?: string;
  runtimeCrossing?: RuntimeCrossing;
}): Promise<AgentRunRecord> {
  const backend = await prepareAgentRuntimeBackendDriver(
    params.runtime.backend,
  );

  const environment = params.runtime.environmentId
    ? await EnvironmentModel.findByIdForOrganization(
        params.runtime.environmentId,
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
    environmentId: params.runtime.environmentId,
    environmentNetworkPolicy: environment?.networkPolicy,
    defaultNetworkPolicy: organization?.defaultNetworkPolicy,
  });
  const inputFiles = await AgentRunInputModel.findByTaskId(params.taskId);
  const runId = randomUUID();

  const priorRun = params.resumeFromTaskId
    ? await AgentRunModel.findByTaskId(params.resumeFromTaskId)
    : null;
  const workspace = priorRun
    ? await AgentWorkspaceModel.findByWorkloadName(priorRun.workloadName)
    : null;
  if (
    params.resumeFromTaskId &&
    (!priorRun ||
      !workspace ||
      workspace.organizationId !== params.organizationId ||
      workspace.actorKind !== params.actor.kind ||
      workspace.actorId !== params.actor.id ||
      workspace.agentId !== params.agentId ||
      workspace.runtimeScope !== runtimeScope)
  )
    throw tagAgentRunFailure(
      new ApiError(
        409,
        "The prior run is unavailable for this actor, Agent, or environment",
      ),
      "run.resume_refused",
    );

  let task = params.task;
  if (params.runtimeCrossing && !params.resumeFromTaskId) {
    const agent = await AgentModel.findById(params.agentId);
    if (!agent) throw new ApiError(404, "Agent not found");
    const contract = await bindRuntimeChild({
      crossing: params.runtimeCrossing,
      organizationId: params.organizationId,
      workspaceId: params.taskId,
      workloadName: constructStableRunName(agent.name, params.taskId),
      actorKind: params.actor.kind,
      actorId: params.actor.id,
    });
    task = promptWithContract(task, contract);
  }

  const { spec, virtualApiKeyId, gatewayTokenId } =
    await buildAgentRunLaunchSpec({
      runtime: params.runtime,
      taskId: params.taskId,
      runId,
      agentId: params.agentId,
      actor: params.actor,
      organizationId: params.organizationId,
      runtimeScope,
      effectiveNetworkPolicy,
      appName: organization?.appName ?? DEFAULT_APP_NAME,
      task,
      runMode: params.runMode,
      inputFiles,
      ...(workspace
        ? {
            workspaceId: workspace.id,
            runtimeSession: runtimeOpenAppaSession({
              organizationId: params.organizationId,
              workspaceId: workspace.id,
              workloadName: workspace.workloadName,
              actorKind: workspace.actorKind,
              actorId: workspace.actorId,
            }),
          }
        : {}),
    });

  if (workspace) {
    spec.frozenName = workspace.workloadName;
    // A new turn does not buy another full workspace lifetime. Keep the UI's
    // run deadline aligned with the original controller shutdown timestamp.
    spec.activeDeadlineSeconds = Math.max(
      1,
      Math.ceil((workspace.expiresAt.getTime() - Date.now()) / 1000),
    );
  }
  spec.env.ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID = spec.frozenName;

  // The row lands before the workload: it is what teardown reads to find the
  // objects, so a crash between the two must leave a record, not an orphan.
  const resumeWithoutPrompt = Boolean(priorRun && !params.task?.trim());
  const placeholderTitle =
    params.title ??
    (resumeWithoutPrompt && priorRun
      ? priorRun.title
      : toPlaceholderTitle(params.task ?? "Run"));
  const session = await AgentRunModel.create({
    id: runId,
    organizationId: params.organizationId,
    taskId: params.taskId,
    agentId: params.runtime.agentId,
    actorKind: params.actor.kind,
    actorId: params.actor.id,
    actorUserId: params.actor.kind === "user" ? params.actor.id : null,
    title: placeholderTitle,
    projectId: params.projectId,
    workloadName: spec.frozenName,
    backend: backend.name,
    runtimeScope,
    activeDeadlineSeconds: spec.activeDeadlineSeconds,
    virtualApiKeyId,
    gatewayTokenId,
    completionTarget: params.completionTarget,
  });

  if (params.title === undefined && !resumeWithoutPrompt) {
    trackBackgroundWork(
      generateAgentRunTitle({
        taskId: params.taskId,
        prompt: params.task ?? "Run",
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
            "Could not generate an Agent run title",
          );
        }),
    );
  }

  let claimedWorkspace = false;
  let createdWorkspace:
    | Awaited<ReturnType<typeof AgentWorkspaceModel.create>>
    | undefined;
  try {
    if (workspace) {
      const claimed = await AgentWorkspaceModel.claim({
        id: workspace.id,
        organizationId: params.organizationId,
        actorKind: params.actor.kind,
        actorId: params.actor.id,
        agentId: params.agentId,
        taskId: params.taskId,
      });
      if (!claimed)
        // The route checked retention before starting, so a lost claim is
        // almost always a concurrent turn; an expired workspace is refused
        // synchronously on the next attempt.
        throw tagAgentRunFailure(
          new ApiError(
            409,
            "This Agent is already in use or its saved files have reached their retention deadline",
          ),
          "run.workspace_busy",
        );
      claimedWorkspace = true;
      await notifyRuntimeSessionCreated(params, workspace.id);
      const previous = await AgentRunModel.findByTaskId(workspace.lastTaskId);
      if (previous?.virtualApiKeyId)
        await cleanupAgentRun(previous, { requireTranscript: true });
      if (params.runtimeCrossing) {
        await admitRuntimeSteer({
          crossing: params.runtimeCrossing,
          organizationId: params.organizationId,
          workspaceId: workspace.id,
        });
      }
      await stampRuntimeBinding({
        spec,
        organizationId: params.organizationId,
        workspaceId: workspace.id,
        taskId: params.taskId,
      });
      await backend.continueRun({ session, spec });
    } else {
      createdWorkspace = await AgentWorkspaceModel.create({
        // The initial public run URL is the permanent session URL.
        id: params.taskId,
        organizationId: params.organizationId,
        agentId: params.agentId,
        actorKind: params.actor.kind,
        actorId: params.actor.id,
        backend: backend.name,
        runtimeScope,
        workloadName: spec.frozenName,
        activeTaskId: params.taskId,
        lastTaskId: params.taskId,
        expiresAt: new Date(
          Date.now() +
            (spec.activeDeadlineSeconds ??
              config.agentRuntime.defaultTtlHours * 3600) *
              1000,
        ),
      });
      await notifyRuntimeSessionCreated(params, createdWorkspace.id);
      await stampRuntimeBinding({
        spec,
        organizationId: params.organizationId,
        workspaceId: createdWorkspace.id,
        taskId: params.taskId,
      });
      await backend.launch(spec);
      await backend.stageInputs({ session, inputs: inputFiles });
    }
  } catch (error) {
    const launchFailure = describeLaunchFailure(error);
    // Settle the task before cleanup is visible: the reconciler cancels any
    // unfinished task whose workspace is being deleted, which would otherwise
    // replace this launch error with a generic reason.
    await recordLaunchFailure({
      taskId: params.taskId,
      failure: launchFailure,
    });
    // A publication can succeed before its exec connection fails. Keep the
    // claim until stopping that possibly-running turn has been acknowledged.
    try {
      let suspended = false;
      if (claimedWorkspace)
        suspended = (await backend.stopRun(session)) === "suspended";
      if (workspace) {
        await backend.releaseRun(session);
        if (claimedWorkspace)
          await AgentWorkspaceModel.release({
            workloadName: session.workloadName,
            taskId: session.taskId,
            suspended,
          });
      } else {
        if (createdWorkspace)
          await AgentWorkspaceModel.transition({
            id: createdWorkspace.id,
            from: "active",
            to: "deleting",
          });
        await backend.teardown(session);
        if (createdWorkspace)
          await AgentWorkspaceModel.transition({
            id: createdWorkspace.id,
            from: "deleting",
            to: "deleted",
          });
      }
      await AgentRunModel.close({ id: session.id });
    } catch (cleanupError) {
      // Leave the session open for terminal reconciliation, including failed
      // stop/revoke attempts. Never release another task's workspace claim.
      logger.warn(
        { error: cleanupError, sessionId: session.id },
        "Cleanup after a failed Agent Runtime launch will retry",
      );
    }
    throw launchFailure;
  }

  return session;
}

/** Runtime-ready runtime for an Agent that opted into Agent Runtime. */
export function resolveAgentRuntime(
  agent: Pick<
    Agent,
    "id" | "organizationId" | "environmentId" | "runtime" | "runtimeSecretId"
  >,
): ResolvedAgentRuntime | null {
  if (!agent.runtime) {
    return null;
  }
  return {
    ...agent.runtime,
    image: followAgentCatalogImage({
      image: agent.runtime.image,
      catalogImages: config.agentRuntime.catalogImages,
    }),
    agentId: agent.id,
    organizationId: agent.organizationId,
    environmentId: agent.environmentId,
    secretId: agent.runtimeSecretId,
  };
}

/**
 * Run one delegated A2A task to completion, shaped as the lifecycle's
 * `executeRun`.
 *
 * Ordering matters here. The run is started, then followed, then waited
 * on. A backend outcome rather than the log stream ends the task because an
 * output connection can stop before the workload does. Teardown runs in a
 * finally so a crash, cancellation and a clean finish all release the runtime,
 * the actor's injected credentials, and the minted virtual key.
 */
export async function runTaskInAgentRuntime(params: {
  runtime: ResolvedAgentRuntime;
  taskId: string;
  agentId: string;
  actor: A2AActor;
  organizationId: string;
  projectId?: string | null;
  completionTarget?: AgentRunCompletionTarget;
  onRuntimeSessionCreated?: RuntimeSessionCreatedCallback;
  task?: string | null;
  title?: string;
  runMode: "interactive" | "one_shot";
  modelId: string | null;
  llmApiKeyId: string | null;
  titleUserId?: string;
  resumeFromTaskId?: string;
  runtimeCrossing?: RuntimeCrossing;
  onTextDelta?: (delta: string) => void;
  abortSignal?: AbortSignal;
}): Promise<A2AExecuteResult> {
  const launchedAt = Date.now();
  try {
    const session = await startAgentRunSession(params);
    return await followAgentRun({
      session,
      launchedAt,
      onTextDelta: params.onTextDelta,
      abortSignal: params.abortSignal,
    });
  } catch (error) {
    await recordRunFailure({
      taskId: params.taskId,
      failure: error,
      abortSignal: params.abortSignal,
    });
    throw error;
  }
}

/**
 * Re-attach the durable A2A lifecycle to a run that survived a control
 * plane restart. Its original backend owns the work; this process resumes output capture,
 * heartbeats and terminal settlement without launching a second workload.
 */
export async function resumeAgentRun(params: {
  session: AgentRunRecord;
  onTextDelta?: (delta: string) => void;
  abortSignal?: AbortSignal;
}): Promise<A2AExecuteResult> {
  try {
    return await followAgentRun({
      session: params.session,
      onTextDelta: params.onTextDelta,
      abortSignal: params.abortSignal,
    });
  } catch (error) {
    await recordRunFailure({
      taskId: params.session.taskId,
      failure: error,
      abortSignal: params.abortSignal,
    });
    throw error;
  }
}

/** Clean up a session whose task settled while no backend owned its run. */
export async function cleanupAgentRun(
  session: AgentRunRecord,
  options?: { requireTranscript?: boolean },
): Promise<void> {
  const backend = resolveAgentRuntimeBackendDriver(session.backend);
  const workspace = await AgentWorkspaceModel.findByWorkloadName(
    session.workloadName,
  );
  const task = await A2ATaskModel.findById(session.taskId);
  // Stop first: the supervisor publishes the final transcript before acknowledging
  // cancellation. Never stop a newer turn that already claimed this workspace.
  let suspended = false;
  if (
    workspace?.activeTaskId === session.taskId &&
    (task?.state === "TASK_STATE_CANCELED" ||
      task?.state === "TASK_STATE_FAILED")
  ) {
    suspended =
      (await backend.stopRun(session).catch((error) => {
        if (!isK8sNotFoundError(error)) throw error;
        return undefined;
      })) === "suspended";
  }
  const output = new AgentRuntimeOutputCapture({
    backend,
    session,
    throwOnSnapshotError:
      options?.requireTranscript || workspace?.state === "deleting",
  });
  const stopCapture = new AbortController();
  const capture = output.follow(stopCapture.signal);
  await Promise.race([capture, delayMs(LOG_DRAIN_GRACE_MS)]);
  stopCapture.abort();
  await output
    .recoverSnapshot(AbortSignal.timeout(OUTPUT_SNAPSHOT_TIMEOUT_MS))
    .catch((error) => {
      // The workspace and its retained volume are already gone. There is no
      // transcript left to recover, so close the run and clear its credentials.
      if (!isK8sNotFoundError(error)) throw error;
    });
  await persistTranscript({
    session,
    output,
    required: options?.requireTranscript || workspace?.state === "deleting",
  });
  await backend.releaseRun(session, {
    retainInteractiveSession:
      !options?.requireTranscript &&
      task?.state === "TASK_STATE_COMPLETED" &&
      ["active", "idle"].includes(workspace?.state ?? ""),
  });
  await AgentWorkspaceModel.release({
    workloadName: session.workloadName,
    taskId: session.taskId,
    suspended,
  });
  await AgentRunModel.close({
    id: session.id,
    logs: output.retainedLogs || undefined,
  });
}

async function followAgentRun(params: {
  session: AgentRunRecord;
  launchedAt?: number;
  onTextDelta?: (delta: string) => void;
  abortSignal?: AbortSignal;
}): Promise<A2AExecuteResult> {
  const backend = resolveAgentRuntimeBackendDriver(params.session.backend);
  const { session } = params;
  const output = new AgentRuntimeOutputCapture({
    backend,
    session,
    onTextDelta: params.onTextDelta,
  });
  let outcome: "succeeded" | "failed" | "aborted" = "failed";

  try {
    if (params.launchedAt === undefined) {
      await backend.recoverRun(session);
      await backend.stageInputs({
        session,
        inputs: await AgentRunInputModel.findByTaskId(session.taskId),
      });
    }
    await backend.waitUntilRunning({
      session,
      abortSignal: params.abortSignal,
    });
    // Measured from the launch call rather than from the session row, so the
    // number answers "how long until this could do work" — image pull and
    // scheduling included, which is where the time actually goes.
    if (params.launchedAt !== undefined) {
      reportAgentRuntimeProvisioned((Date.now() - params.launchedAt) / 1000);
    }
    reportAgentRuntimeStarted();

    // Logs are followed on their own promise: the backend outcome ends the
    // run, and a stream that dies early (runtime replaced, connection dropped)
    // must not be mistaken for the task finishing.
    const stopStreaming = new AbortController();
    const streaming = output.follow(
      params.abortSignal
        ? AbortSignal.any([params.abortSignal, stopStreaming.signal])
        : stopStreaming.signal,
    );

    const completion = await backend.waitForCompletion({
      session,
      abortSignal: params.abortSignal,
    });
    outcome = completion.outcome;

    // Give the tail of the log a moment to arrive before settling: the last
    // write and the backend's outcome race, and dropping it would truncate
    // the answer at exactly the point the reader cares about.
    await Promise.race([streaming, delayMs(LOG_DRAIN_GRACE_MS)]);
    stopStreaming.abort();

    await output.recoverSnapshot(
      AbortSignal.timeout(OUTPUT_SNAPSHOT_TIMEOUT_MS),
    );

    const text = extractFinalAnswer(output.transcript);

    if (completion.outcome === "failed") {
      // Read the spend cap before teardown revokes the run's virtual key: a
      // client exits with its own provider error when the proxy refuses it.
      throw tagAgentRunFailure(
        new ApiError(
          502,
          completion.reason ??
            "The Agent Runtime run exited without completing",
        ),
        (await hasExhaustedRunBudget(session))
          ? agentRunFailure("budget.exceeded")
          : (completion.failure ?? agentRunFailure("turn.exit_status")),
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
    reportAgentRuntimeTerminated(
      outcome === "succeeded"
        ? "completed"
        : outcome === "aborted"
          ? "stopped_by_user"
          : "failed",
    );
    let cleanupSucceeded = true;
    let suspended = false;
    await (async () => {
      if (outcome !== "succeeded" || params.abortSignal?.aborted) {
        suspended = (await backend.stopRun(session)) === "suspended";
        await output.recoverSnapshot(
          AbortSignal.timeout(OUTPUT_SNAPSHOT_TIMEOUT_MS),
        );
      }
      await backend.releaseRun(session, {
        retainInteractiveSession: outcome === "succeeded",
      });
    })().catch((error) => {
      cleanupSucceeded = false;
      logger.warn(
        { error, sessionId: session.id, taskId: session.taskId },
        "Agent Runtime run teardown did not complete",
      );
    });
    await persistTranscript({ session, output });
    const workspace = await AgentWorkspaceModel.findByWorkloadName(
      session.workloadName,
    );
    // Expiry owns strict final capture. Do not let this best-effort follower
    // close the run and make the reaper skip a failed transcript recovery.
    if (workspace?.state === "deleting") cleanupSucceeded = false;
    // Keep failed cleanup open so terminal reconciliation can retry it.
    if (cleanupSucceeded)
      await AgentRunModel.close({
        id: session.id,
        logs: output.retainedLogs,
      }).catch((error) => {
        logger.warn(
          { error, sessionId: session.id, taskId: session.taskId },
          "Could not mark the Agent run as ended",
        );
      });
    if (cleanupSucceeded) {
      await AgentWorkspaceModel.release({
        workloadName: session.workloadName,
        taskId: session.taskId,
        suspended,
      });
    }
  }
}

async function persistTranscript(params: {
  session: AgentRunRecord;
  output: AgentRuntimeOutputCapture;
  required?: boolean;
}): Promise<void> {
  // A later reconciliation may find the workspace already suspended or gone.
  // No recovered bytes is not evidence that the prior transcript was empty.
  if (
    params.output.observedTranscriptBytes === 0 &&
    !params.output.readableTranscript
  )
    return;
  await agentRunTranscriptStore
    .persist({
      runId: params.session.id,
      transcript: params.output.completeTranscript,
      observedBytes: params.output.observedTranscriptBytes,
      readableTranscript: params.output.readableTranscript,
    })
    .catch((error) => {
      if (params.required) throw error;
      logger.warn(
        {
          error,
          sessionId: params.session.id,
          taskId: params.session.taskId,
        },
        "Could not retain the complete Agent run transcript",
      );
    });
}

/**
 * The launch error becomes the run's failure reason. A raw Kubernetes client
 * error dumps status, body and every response header; keep only what an
 * administrator can act on.
 */
function describeLaunchFailure(error: unknown): unknown {
  const summary = describeK8sApiError(error);
  if (!summary) return error;
  const transient = isTransientK8sApiError(error);
  const message = transient
    ? `Agent Runtime could not start the run because the Kubernetes API was overloaded or unavailable (${summary}). Start the run again in a minute.`
    : `Agent Runtime could not start the run. ${summary}.`;
  return tagAgentRunFailure(
    new Error(message, { cause: error }),
    transient ? "launch.kubernetes_unavailable" : "launch.kubernetes_rejected",
  );
}

async function recordLaunchFailure(params: {
  taskId: string;
  failure: unknown;
}): Promise<void> {
  try {
    const task = await A2ATaskModel.findById(params.taskId);
    if (!task) return;
    await settleFailedA2ATask({
      taskId: task.id,
      contextId: task.contextId,
      statusReason:
        params.failure instanceof Error
          ? params.failure.message
          : String(params.failure),
      failure: classifyAgentRunFailure(params.failure),
    });
  } catch (error) {
    // The run lifecycle settles the task from the rethrown error as well.
    logger.warn(
      { error, taskId: params.taskId },
      "Could not record an Agent Runtime run failure",
    );
  }
}

/**
 * Settle a runtime task with its classified failure before the generic A2A
 * lifecycle records the same reason without one. A no-op when the task is
 * already terminal (an earlier launch settlement or a cancellation won), and
 * skipped on abort: the lifecycle records that as a cancellation.
 */
async function recordRunFailure(params: {
  taskId: string;
  failure: unknown;
  abortSignal?: AbortSignal;
}): Promise<void> {
  if (params.abortSignal?.aborted) return;
  await recordLaunchFailure({ taskId: params.taskId, failure: params.failure });
}

/** Whether the run's virtual key spent its whole `maxCostUsd` cap. */
async function hasExhaustedRunBudget(
  session: AgentRunRecord,
): Promise<boolean> {
  if (!session.virtualApiKeyId) return false;
  try {
    const cap = (
      await LimitModel.findSpendCaps({
        entityType: "virtual_key",
        entityIds: [session.virtualApiKeyId],
      })
    ).get(session.virtualApiKeyId);
    return cap !== undefined && cap.currentUsage >= cap.limitValue;
  } catch (error) {
    logger.warn(
      { error, taskId: session.taskId },
      "Could not read the Agent run spend cap",
    );
    return false;
  }
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

/**
 * Fence a maintained image writes its final answer between when the agent
 * ran under a full-screen TUI. The pane transcript is then a screen
 * recording — cursor moves, redraws, box glyphs — and joining it produces
 * an unreadable "answer". A runtime that renders a TUI prints the fence and
 * the answer once, after the session ends, so the reader gets prose.
 *
 * Absent (every one-shot runtime, and any image that predates this), the
 * whole transcript is the answer, exactly as before.
 */
const FINAL_ANSWER_FENCE = "===ARCHESTRA-FINAL-ANSWER===";
const FINAL_ANSWER_END_FENCE = "===ARCHESTRA-FINAL-ANSWER-END===";

/**
 * Take what a runtime fenced as its final answer, else the whole transcript.
 * The LAST fence wins: a TUI can scroll an earlier one back into view, and
 * the runtime prints the real one after the session is over.
 */
/** @public — exercised through pod-run.test.ts */
export function extractFinalAnswer(transcript: string): string {
  const start = transcript.lastIndexOf(FINAL_ANSWER_FENCE);
  if (start === -1) return transcript;
  const answerStart = start + FINAL_ANSWER_FENCE.length;
  const end = transcript.indexOf(FINAL_ANSWER_END_FENCE, answerStart);
  const answer = transcript.slice(answerStart, end === -1 ? undefined : end);
  // A fence with nothing after it means the runtime died mid-write; the
  // transcript is worth more than an empty string.
  return answer.trim() === "" ? transcript : answer.replace(/^\r?\n/, "");
}

const LOG_DRAIN_GRACE_MS = 2_000;
// A retained PVC may need attachment to a temporary recovery Pod first.
const OUTPUT_SNAPSHOT_TIMEOUT_MS = 120_000;

type RuntimeSessionCreatedCallback = (session: {
  taskId: string;
  workspaceId: string;
}) => Promise<void>;

async function notifyRuntimeSessionCreated(
  params: {
    taskId: string;
    onRuntimeSessionCreated?: RuntimeSessionCreatedCallback;
  },
  workspaceId: string,
): Promise<void> {
  try {
    await params.onRuntimeSessionCreated?.({
      taskId: params.taskId,
      workspaceId,
    });
  } catch (error) {
    logger.warn(
      { error, taskId: params.taskId },
      "Could not announce the Agent Runtime session",
    );
  }
}
