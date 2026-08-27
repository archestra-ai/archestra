import type { Writable } from "node:stream";
import type { RunnerLaunchSpec } from "@/k8s/runner-runtime/manifests";
import type { RunnerSession } from "@/types";

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

  /** Schedule the workload. Returns once accepted, not once running. */
  launch(spec: RunnerLaunchSpec): Promise<void>;

  /**
   * Resolve once the session is doing work, or throw if it never gets there.
   * A session that has already finished counts as started: a fast task must
   * not be mistaken for one that failed to schedule.
   */
  waitUntilRunning(params: {
    session: RunnerSession;
    abortSignal?: AbortSignal;
  }): Promise<void>;

  /** Follow the session's output. Resolves when the stream ends. */
  streamOutput(params: {
    session: RunnerSession;
    destination: Writable;
    abortSignal?: AbortSignal;
  }): Promise<void>;

  /**
   * Wait for the session to reach an outcome.
   *
   * `aborted` is returned rather than thrown, so the caller can tell a
   * cancellation apart from a failure without inspecting an error.
   */
  waitForCompletion(params: {
    session: RunnerSession;
    abortSignal?: AbortSignal;
  }): Promise<RunnerCompletion>;

  /** Release everything the session holds. Safe to call more than once. */
  teardown(session: RunnerSession): Promise<void>;
}

/** Mirrors `RunnerBackendNameSchema`; the column stores exactly these. */
export type RunnerBackendName = "kubernetes";

export interface RunnerCompletion {
  outcome: "succeeded" | "failed" | "aborted";
  reason?: string;
}
