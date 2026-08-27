import { ApiError } from "@/types";
import { kubernetesRunnerBackend } from "./kubernetes";
import type { RunnerBackend, RunnerBackendName } from "./types";

export type { RunnerBackend, RunnerBackendName } from "./types";

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
 * The backend a runner executes on.
 *
 * Refuses rather than falling back: silently running work somewhere other than
 * where the runner says would make its environment and egress rules a lie.
 */
export function resolveRunnerBackend(name: RunnerBackendName): RunnerBackend {
  const backend = BACKENDS[name];
  if (!backend) {
    throw new ApiError(400, `Unknown runner backend "${name}"`);
  }
  if (!backend.isEnabled) {
    throw new ApiError(
      503,
      `The "${name}" runner backend is not available on this deployment, so this task cannot run`,
    );
  }
  return backend;
}
