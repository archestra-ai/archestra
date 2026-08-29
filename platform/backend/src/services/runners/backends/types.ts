import type { Readable, Writable } from "node:stream";
import type WebSocket from "ws";
import type {
  AgentDeploymentBackend,
  AgentDeploymentResources,
  AgentDeploymentSteerMode,
  AgentExecutionInput,
  AgentRun,
  EffectiveNetworkPolicy,
} from "@/types";

/**
 * Runtime-neutral description of one isolated Agent execution.
 *
 * The control plane resolves identity, credentials, inference, tools, limits,
 * and network intent before crossing this boundary. A backend translates the
 * result into its own vocabulary: a Kubernetes Job today, and potentially a
 * VM or managed sandbox later.
 */
export type RunnerLaunchSpec = {
  taskId: string;
  runnerId: string;
  frozenName: string;
  /** Backend placement scope (a namespace, VM pool, region, or sandbox tier). */
  runtimeScope: string;
  image: string;
  command: string[] | null;
  privileged: boolean;
  resources: AgentDeploymentResources | null;
  env: Record<string, string>;
  secretEnv: Record<string, string>;
  activeDeadlineSeconds: number | null;
  /** Writable scratch-space ceiling enforced by the execution backend. */
  ephemeralStorageLimit: string;
  imagePullSecrets: string[];
  effectiveNetworkPolicy: EffectiveNetworkPolicy;
  /** Number of durable input files the backend must stage before entrypoint. */
  inputFileCount: number;
};

/**
 * How a runner's work is actually executed.
 *
 * The execution path above this deliberately knows nothing about Kubernetes.
 * A session is a place that runs a command, produces a stream of output,
 * reaches an outcome, accepts an interjection and can be torn down — and a
 * pod, a VM and an agent-sandbox all satisfy that. Keeping the seam here means
 * adding a backend is a new file plus a registry entry, not a change to the
 * A2A task lifecycle.
 *
 * Deliberately not on this interface: anything that names a Kubernetes object.
 * A backend owns how it schedules work and how it addresses what it scheduled.
 */
export interface RunnerBackend {
  /** Stable identifier stored on the runner definition. */
  readonly name: RunnerBackendName;

  /** Whether this deployment can actually run work on this backend. */
  readonly isEnabled: boolean;

  /**
   * Select the backend-owned placement scope for a new execution.
   * Existing Environment/organization scopes are hints; an adapter may map
   * them to a namespace, VM pool, region, sandbox tier, or another target.
   */
  resolveRuntimeScope(params: {
    environmentScope?: string | null;
    organizationScope?: string | null;
  }): string;

  /** Schedule the workload. Returns once accepted, not once running. */
  launch(spec: RunnerLaunchSpec): Promise<void>;

  /** Materialize durable task inputs before the Agent command is released. */
  stageInputs(params: {
    session: AgentRun;
    inputs: AgentExecutionInput[];
  }): Promise<void>;

  /**
   * Resolve once the session is doing work, or throw if it never gets there.
   * A session that has already finished counts as started: a fast task must
   * not be mistaken for one that failed to schedule.
   */
  waitUntilRunning(params: {
    session: AgentRun;
    abortSignal?: AbortSignal;
  }): Promise<void>;

  /** Follow the session's output. Resolves when the stream ends. */
  streamOutput(params: {
    session: AgentRun;
    destination: Writable;
    lines?: number;
    abortSignal?: AbortSignal;
  }): Promise<void>;

  /** Interject into a live execution using the deployment's delivery mode. */
  steer(params: {
    session: AgentRun;
    steerMode: AgentDeploymentSteerMode;
    message: string;
  }): Promise<void>;

  /** Attach an interactive terminal to the execution. */
  attach(params: {
    session: AgentRun;
    stdin: Readable;
    stdout: Writable;
    stderr: Writable;
    onStatus?: (status: RunnerAttachStatus) => void;
  }): Promise<RunnerAttachment>;

  /**
   * Wait for the session to reach an outcome.
   *
   * `aborted` is returned rather than thrown, so the caller can tell a
   * cancellation apart from a failure without inspecting an error.
   */
  waitForCompletion(params: {
    session: AgentRun;
    abortSignal?: AbortSignal;
  }): Promise<RunnerCompletion>;

  /** Release everything the session holds. Safe to call more than once. */
  teardown(session: AgentRun): Promise<void>;

  /** Serialize adoption/teardown for one execution across control-plane replicas. */
  withSessionLease(
    session: AgentRun,
    operation: () => Promise<void>,
  ): Promise<boolean>;
}

/** Mirrors `AgentDeploymentBackendSchema`; durable runs store exactly these. */
export type RunnerBackendName = AgentDeploymentBackend;

export interface RunnerCompletion {
  outcome: "succeeded" | "failed" | "aborted";
  reason?: string;
}

export interface RunnerAttachStatus {
  outcome: "success" | "failure";
  message?: string;
}

export interface RunnerAttachment {
  /** Operator-facing diagnostic command, never needed for transport. */
  command: string;
  /** Backend-native resource identifier, useful for diagnostics only. */
  resourceName: string;
  socket: WebSocket;
}
