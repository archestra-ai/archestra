import type { Readable, Writable } from "node:stream";
import type { AgentRunControl } from "@archestra/shared";
import type WebSocket from "ws";
import config from "@/config";
import { agentRuntimeManager } from "@/k8s/agent-runtime";
import type {
  AgentRunInput,
  AgentRunRecord,
  AgentRunStartupProgress,
  AgentRuntimeSteerMode,
} from "@/types";
import { ApiError } from "@/types";
import type { AgentWorkspaceFileRequest } from "@/types/agent-workspace-file";
import type {
  AgentRunAttachment,
  AgentRunAttachProgress,
  AgentRunAttachStatus,
  AgentRunCompletion,
  AgentRunLaunchSpec,
  AgentRuntimeBackendDriver,
} from "./types";

/**
 * Kubernetes backend: one persistent Sandbox per workspace. Its supervisor
 * executes each run once, retaining files without replaying completed turns.
 */
class KubernetesAgentRuntimeBackendDriver implements AgentRuntimeBackendDriver {
  readonly name = "kubernetes" as const;

  get isEnabled(): boolean {
    return agentRuntimeManager.isEnabled;
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

  async controlSession(params: {
    session: AgentRunRecord;
    commandId: string;
    control: AgentRunControl;
  }): Promise<void> {
    await agentRuntimeManager.controlSession(params);
  }

  async launch(spec: AgentRunLaunchSpec): Promise<void> {
    await agentRuntimeManager.launch(spec);
  }

  async continueRun(params: {
    session: AgentRunRecord;
    spec: AgentRunLaunchSpec;
  }): Promise<void> {
    await agentRuntimeManager.continueRun(params);
  }

  async hasRetainedTerminal(
    session: Pick<AgentRunRecord, "taskId" | "runtimeScope" | "workloadName">,
  ): Promise<boolean> {
    return agentRuntimeManager.hasRetainedTerminal(session);
  }

  async releaseRun(
    session: AgentRunRecord,
    options?: { retainInteractiveSession?: boolean },
  ): Promise<void> {
    await agentRuntimeManager.releaseRun(session, options);
  }

  async recoverRun(session: AgentRunRecord): Promise<void> {
    await agentRuntimeManager.recoverRun(session);
  }

  async stopRun(session: AgentRunRecord): Promise<"suspended" | undefined> {
    return agentRuntimeManager.stopRun(session);
  }

  getWorkspaceConnection(
    session: Pick<AgentRunRecord, "workloadName" | "runtimeScope">,
  ) {
    return agentRuntimeManager.getWorkspaceConnection(session);
  }

  async accessWorkspaceFile(params: {
    session: AgentRunRecord;
    request: AgentWorkspaceFileRequest;
  }) {
    return agentRuntimeManager.accessWorkspaceFile(params);
  }

  async suspendWorkspace(
    session: Pick<AgentRunRecord, "id" | "runtimeScope" | "workloadName">,
  ): Promise<void> {
    await agentRuntimeManager.suspendWorkspace(session);
  }

  async resumeWorkspace(session: AgentRunRecord): Promise<void> {
    await agentRuntimeManager.resumeWorkspace(session);
  }

  async getLastWorkspaceActivity(
    session: AgentRunRecord,
  ): Promise<Date | null> {
    return agentRuntimeManager.getLastWorkspaceActivity(session);
  }

  async deleteWorkspace(
    session: Pick<AgentRunRecord, "id" | "runtimeScope" | "workloadName">,
  ): Promise<void> {
    await agentRuntimeManager.deleteWorkspace(session);
  }

  async stageInputs(params: {
    session: AgentRunRecord;
    inputs: AgentRunInput[];
  }): Promise<void> {
    await agentRuntimeManager.stageInputs(params);
  }

  async waitUntilRunning(params: {
    session: AgentRunRecord;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    const deadline =
      Date.now() + config.agentRuntime.podStartTimeoutSeconds * 1000;

    while (!params.abortSignal?.aborted) {
      const pod = await agentRuntimeManager.findPodPhase(params.session);
      // Any phase but Pending means the container got as far as running,
      // including one that has already finished.
      if (pod && pod.phase !== "Pending") return;
      if (Date.now() > deadline) {
        throw new ApiError(
          504,
          "The Agent Runtime run did not start in time. The image may be unavailable, or the cluster may have no room to schedule it.",
        );
      }
      await delay(POD_START_POLL_MS, params.abortSignal);
    }
  }

  async getStartupProgress(
    session: Pick<AgentRunRecord, "taskId" | "runtimeScope" | "workloadName">,
  ): Promise<AgentRunStartupProgress> {
    return agentRuntimeManager.getStartupProgress(session);
  }

  async streamOutput(params: {
    session: AgentRunRecord;
    destination: Writable;
    lines?: number;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    await agentRuntimeManager.streamLogs({
      session: params.session,
      destination: params.destination,
      lines: params.lines ?? AGENT_RUNTIME_LOG_TAIL_LINES,
      abortSignal: params.abortSignal,
    });
  }

  async snapshotOutput(params: {
    session: AgentRunRecord;
    destination: Writable;
    lines?: number;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    await agentRuntimeManager.snapshotLogs({
      session: params.session,
      destination: params.destination,
      lines: params.lines ?? AGENT_RUNTIME_LOG_TAIL_LINES,
      abortSignal: params.abortSignal,
    });
  }

  async steer(params: {
    session: AgentRunRecord;
    steerMode: AgentRuntimeSteerMode;
    message: string;
  }): Promise<void> {
    await agentRuntimeManager.steer(params);
  }

  async attach(params: {
    session: AgentRunRecord;
    stdin: Readable;
    stdout: Writable;
    stderr: Writable;
    onStatus?: (status: AgentRunAttachStatus) => void;
    onProgress?: (progress: AgentRunAttachProgress) => void;
  }): Promise<AgentRunAttachment> {
    const attachment = await agentRuntimeManager.attach({
      session: params.session,
      stdin: params.stdin,
      stdout: params.stdout,
      stderr: params.stderr,
      onProgress: params.onProgress,
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
    session: AgentRunRecord;
    abortSignal?: AbortSignal;
  }): Promise<AgentRunCompletion> {
    return agentRuntimeManager.waitForCompletion(params);
  }

  async teardown(session: AgentRunRecord): Promise<void> {
    await agentRuntimeManager.teardown(session);
  }

  async withSessionLease(
    session: AgentRunRecord,
    operation: () => Promise<void>,
  ): Promise<boolean> {
    return agentRuntimeManager.withSessionLease(session, operation);
  }
}

export const kubernetesAgentRuntimeBackendDriver =
  new KubernetesAgentRuntimeBackendDriver();

// ===================== internals =====================

const POD_START_POLL_MS = 1_000;
/** An image pull on a cold node is the slow case this has to tolerate. */
/** From the start of the session: a task's own output is the whole transcript. */
const AGENT_RUNTIME_LOG_TAIL_LINES = Number.MAX_SAFE_INTEGER;

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
