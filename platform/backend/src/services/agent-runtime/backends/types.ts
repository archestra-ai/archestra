import type { Readable, Writable } from "node:stream";
import type { AgentRunAttachPhase } from "@archestra/shared";
import type WebSocket from "ws";
import type {
  AgentRunInput,
  AgentRunRecord,
  AgentRunStartupProgress,
  AgentRuntimeBackend,
  AgentRuntimeResources,
  AgentRuntimeSteerMode,
  EffectiveNetworkPolicy,
} from "@/types";

/**
 * Runtime-neutral description of one isolated Agent run.
 *
 * The control plane resolves identity, credentials, inference, tools, limits,
 * and network intent before crossing this boundary. A backend translates the
 * result into its own vocabulary: a Kubernetes Job today, and potentially a
 * VM or managed sandbox later.
 */
export type AgentRunLaunchSpec = {
  taskId: string;
  agentRuntimeId: string;
  frozenName: string;
  /** Backend placement scope (a namespace, VM pool, region, or sandbox tier). */
  runtimeScope: string;
  image: string;
  command: string[] | null;
  privileged: boolean;
  resources: AgentRuntimeResources | null;
  env: Record<string, string>;
  secretEnv: Record<string, string>;
  activeDeadlineSeconds: number | null;
  /** Writable scratch-space ceiling enforced by the runtime backend. */
  ephemeralStorageLimit: string;
  /**
   * Steers the pod onto a dedicated node pool: applied verbatim as the pod's
   * nodeSelector, with one matching NoSchedule toleration per entry. Empty
   * means no steering.
   */
  nodeSelector: Record<string, string>;
  imagePullSecrets: string[];
  effectiveNetworkPolicy: EffectiveNetworkPolicy;
  /** Number of durable input files the backend must stage before entrypoint. */
  inputFileCount: number;
};

/**
 * How an Agent Runtime run is actually executed.
 *
 * The run path above this deliberately knows nothing about Kubernetes.
 * A session is a place that runs a command, produces a stream of output,
 * reaches an outcome, accepts an interjection and can be torn down — and a
 * pod, a VM and an agent-sandbox all satisfy that. Keeping the seam here means
 * adding a backend is a new file plus a registry entry, not a change to the
 * A2A task lifecycle.
 *
 * Deliberately not on this interface: anything that names a Kubernetes object.
 * A backend owns how it schedules work and how it addresses what it scheduled.
 */
export interface AgentRuntimeBackendDriver {
  /** Stable identifier stored on the Agent Runtime configuration. */
  readonly name: AgentRuntimeBackendName;

  /** Whether this deployment can actually run work on this backend. */
  readonly isEnabled: boolean;

  /**
   * Select the backend-owned placement scope for a new run.
   * Existing Environment/organization scopes are hints; an adapter may map
   * them to a namespace, VM pool, region, sandbox tier, or another target.
   */
  resolveRuntimeScope(params: {
    environmentScope?: string | null;
    organizationScope?: string | null;
  }): string;

  /** Schedule the workload. Returns once accepted, not once running. */
  launch(spec: AgentRunLaunchSpec): Promise<void>;

  /** Materialize durable task inputs before the Agent command is released. */
  stageInputs(params: {
    session: AgentRunRecord;
    inputs: AgentRunInput[];
  }): Promise<void>;

  /**
   * Resolve once the session is doing work, or throw if it never gets there.
   * A session that has already finished counts as started: a fast task must
   * not be mistaken for one that failed to schedule.
   */
  waitUntilRunning(params: {
    session: AgentRunRecord;
    abortSignal?: AbortSignal;
  }): Promise<void>;

  /** Inspect the runtime's current startup wait without opening a terminal. */
  getStartupProgress(
    session: Pick<AgentRunRecord, "taskId" | "runtimeScope">,
  ): Promise<AgentRunStartupProgress>;

  /** Follow the session's output. Resolves when the stream ends. */
  streamOutput(params: {
    session: AgentRunRecord;
    destination: Writable;
    lines?: number;
    abortSignal?: AbortSignal;
  }): Promise<void>;

  /**
   * Read the output currently retained by the backend without following it.
   * Resolves only after the complete snapshot has been written.
   */
  snapshotOutput(params: {
    session: AgentRunRecord;
    destination: Writable;
    lines?: number;
    abortSignal?: AbortSignal;
  }): Promise<void>;

  /** Interject into a live run using the runtime's delivery mode. */
  steer(params: {
    session: AgentRunRecord;
    steerMode: AgentRuntimeSteerMode;
    message: string;
  }): Promise<void>;

  /**
   * Attach an interactive terminal to the run.
   *
   * A backend that has to wait — for placement, for an image, for the agent's
   * session — reports those waits through `onProgress` rather than leaving the
   * caller to stare at an unresolved promise. Reporting is best-effort: a
   * backend that knows nothing about its own startup simply never calls it.
   */
  attach(params: {
    session: AgentRunRecord;
    stdin: Readable;
    stdout: Writable;
    stderr: Writable;
    onStatus?: (status: AgentRunAttachStatus) => void;
    onProgress?: (progress: AgentRunAttachProgress) => void;
  }): Promise<AgentRunAttachment>;

  /**
   * Wait for the session to reach an outcome.
   *
   * `aborted` is returned rather than thrown, so the caller can tell a
   * cancellation apart from a failure without inspecting an error.
   */
  waitForCompletion(params: {
    session: AgentRunRecord;
    abortSignal?: AbortSignal;
  }): Promise<AgentRunCompletion>;

  /** Release everything the session holds. Safe to call more than once. */
  teardown(session: AgentRunRecord): Promise<void>;

  /** Serialize adoption/teardown for one run across control-plane replicas. */
  withSessionLease(
    session: AgentRunRecord,
    operation: () => Promise<void>,
  ): Promise<boolean>;
}

/** Mirrors `AgentRuntimeBackendSchema`; durable runs store exactly these. */
export type AgentRuntimeBackendName = AgentRuntimeBackend;

export interface AgentRunCompletion {
  outcome: "succeeded" | "failed" | "aborted";
  reason?: string;
}

export interface AgentRunAttachStatus {
  outcome: "success" | "failure";
  message?: string;
}

/**
 * One step of an attach that has not completed yet.
 *
 * Runtime-neutral on purpose: "waiting for a node" and "pulling the image" are
 * true of a VM pool or a sandbox tier as much as of a pod, so the vocabulary
 * belongs to the interface rather than to Kubernetes.
 */
export interface AgentRunAttachProgress {
  phase: AgentRunAttachPhase;
  /** Short phrase naming the wait. */
  message: string;
  /** The runtime's own explanation, when it has one. */
  detail?: string | null;
  /** Backend-native resource identifier, once one exists. */
  resourceName?: string | null;
}

export interface AgentRunAttachment {
  /** Operator-facing diagnostic command, never needed for transport. */
  command: string;
  /** Backend-native resource identifier, useful for diagnostics only. */
  resourceName: string;
  socket: WebSocket;
}
