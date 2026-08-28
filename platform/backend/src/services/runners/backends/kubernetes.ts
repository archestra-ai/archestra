import type { Readable, Writable } from "node:stream";
import type WebSocket from "ws";
import config from "@/config";
import { runnerRuntimeManager } from "@/k8s/runner-runtime";
import type {
  AgentDeploymentSteerMode,
  AgentExecutionInput,
  AgentRun,
} from "@/types";
import { ApiError } from "@/types";
import type {
  RunnerAttachment,
  RunnerAttachStatus,
  RunnerBackend,
  RunnerCompletion,
  RunnerLaunchSpec,
} from "./types";

/**
 * Kubernetes backend: one Job per session.
 *
 * A Job rather than a Deployment because a Deployment restarts a container
 * that finished, which would re-run a task's side effects every time it
 * succeeded.
 */
class KubernetesRunnerBackend implements RunnerBackend {
  readonly name = "kubernetes" as const;

  get isEnabled(): boolean {
    return runnerRuntimeManager.isEnabled;
  }

  resolveRuntimeScope(params: {
    environmentScope?: string | null;
    organizationScope?: string | null;
  }): string {
    return (
      params.environmentScope ??
      params.organizationScope ??
      config.orchestrator.kubernetes.namespace
    );
  }

  async launch(spec: RunnerLaunchSpec): Promise<void> {
    await runnerRuntimeManager.launch(spec);
  }

  async stageInputs(params: {
    session: AgentRun;
    inputs: AgentExecutionInput[];
  }): Promise<void> {
    await runnerRuntimeManager.stageInputs(params);
  }

  async waitUntilRunning(params: {
    session: AgentRun;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    const deadline = Date.now() + POD_START_TIMEOUT_MS;

    while (!params.abortSignal?.aborted) {
      const pod = await runnerRuntimeManager.findPodPhase(params.session);
      // Any phase but Pending means the container got as far as running,
      // including one that has already finished.
      if (pod && pod.phase !== "Pending") return;
      if (Date.now() > deadline) {
        throw new ApiError(
          504,
          "The background run did not start in time. The image may be unavailable, or the cluster may have no room to schedule it.",
        );
      }
      await delay(POD_START_POLL_MS, params.abortSignal);
    }
  }

  async streamOutput(params: {
    session: AgentRun;
    destination: Writable;
    lines?: number;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    await runnerRuntimeManager.streamLogs({
      session: params.session,
      destination: params.destination,
      lines: params.lines ?? RUNNER_LOG_TAIL_LINES,
      abortSignal: params.abortSignal,
    });
  }

  async steer(params: {
    session: AgentRun;
    steerMode: AgentDeploymentSteerMode;
    message: string;
  }): Promise<void> {
    await runnerRuntimeManager.steer(params);
  }

  async attach(params: {
    session: AgentRun;
    stdin: Readable;
    stdout: Writable;
    stderr: Writable;
    onStatus?: (status: RunnerAttachStatus) => void;
  }): Promise<RunnerAttachment> {
    const attachment = await runnerRuntimeManager.attach({
      session: params.session,
      stdin: params.stdin,
      stdout: params.stdout,
      stderr: params.stderr,
      onStatus: (status) =>
        params.onStatus?.({
          outcome: status.status === "Failure" ? "failure" : "success",
          message: status.message ?? undefined,
        }),
    });
    return {
      command: attachment.command,
      resourceName: attachment.podName,
      socket: attachment.socket as WebSocket,
    };
  }

  async waitForCompletion(params: {
    session: AgentRun;
    abortSignal?: AbortSignal;
  }): Promise<RunnerCompletion> {
    return runnerRuntimeManager.waitForCompletion(params);
  }

  async teardown(session: AgentRun): Promise<void> {
    await runnerRuntimeManager.teardown(session);
  }

  async withSessionLease(
    session: AgentRun,
    operation: () => Promise<void>,
  ): Promise<boolean> {
    return runnerRuntimeManager.withSessionLease(session, operation);
  }
}

export const kubernetesRunnerBackend = new KubernetesRunnerBackend();

// ===================== internals =====================

const POD_START_POLL_MS = 1_000;
/** An image pull on a cold node is the slow case this has to tolerate. */
const POD_START_TIMEOUT_MS = 5 * 60_000;
/** From the start of the session: a task's own output is the whole transcript. */
const RUNNER_LOG_TAIL_LINES = Number.MAX_SAFE_INTEGER;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
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
