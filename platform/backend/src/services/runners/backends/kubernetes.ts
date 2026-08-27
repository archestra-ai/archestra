import type { Writable } from "node:stream";
import { runnerRuntimeManager } from "@/k8s/runner-runtime";
import type { RunnerLaunchSpec } from "@/k8s/runner-runtime/manifests";
import type { RunnerSession } from "@/types";
import { ApiError } from "@/types";
import type { RunnerBackend, RunnerCompletion } from "./types";

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

  async launch(spec: RunnerLaunchSpec): Promise<void> {
    await runnerRuntimeManager.launch(spec);
  }

  async waitUntilRunning(params: {
    session: RunnerSession;
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
          "The runner pod did not start in time. The image may be unavailable, or the cluster may have no room to schedule it.",
        );
      }
      await delay(POD_START_POLL_MS, params.abortSignal);
    }
  }

  async streamOutput(params: {
    session: RunnerSession;
    destination: Writable;
    abortSignal?: AbortSignal;
  }): Promise<void> {
    await runnerRuntimeManager.streamLogs({
      session: params.session,
      destination: params.destination,
      lines: RUNNER_LOG_TAIL_LINES,
      abortSignal: params.abortSignal,
    });
  }

  async waitForCompletion(params: {
    session: RunnerSession;
    abortSignal?: AbortSignal;
  }): Promise<RunnerCompletion> {
    return runnerRuntimeManager.waitForCompletion(params);
  }

  async teardown(session: RunnerSession): Promise<void> {
    await runnerRuntimeManager.teardown(session);
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
