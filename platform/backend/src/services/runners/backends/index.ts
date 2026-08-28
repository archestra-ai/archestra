import { ApiError } from "@/types";
import { kubernetesRunnerBackend } from "./kubernetes";
import type { RunnerBackend, RunnerBackendName } from "./types";

export type { RunnerBackend, RunnerLaunchSpec } from "./types";

/**
 * Every execution backend this deployment knows how to drive.
 *
 * Adding one — a VM per task, an agent-sandbox, a Dagger-hosted session — is a
 * new implementation of `RunnerBackend` plus an entry here. Nothing in the A2A
 * task lifecycle, the routes or the UI changes.
 */
const BACKENDS: Record<RunnerBackendName, RunnerBackend> = {
  kubernetes: kubernetesRunnerBackend,
};

/**
 * The backend a Background execution deployment uses.
 *
 * Refuses rather than falling back: silently running work somewhere other than
 * where the Agent says would make its environment and egress rules a lie.
 */
export function resolveRunnerBackend(name: RunnerBackendName): RunnerBackend {
  const backend = BACKENDS[name];
  if (!backend) {
    throw new ApiError(400, `Unknown Background execution backend "${name}"`);
  }
  if (!backend.isEnabled) {
    throw new ApiError(
      503,
      `The "${name}" Background execution backend is not available on this deployment, so this task cannot run`,
    );
  }
  return backend;
}

/** Whether this installation has at least one usable execution backend. */
export function isAnyRunnerBackendEnabled(): boolean {
  return Object.values(BACKENDS).some((backend) => backend.isEnabled);
}
