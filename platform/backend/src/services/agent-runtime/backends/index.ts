import { ApiError } from "@/types";
import { kubernetesAgentRuntimeBackendDriver } from "./kubernetes";
import type {
  AgentRuntimeBackendDriver,
  AgentRuntimeBackendName,
} from "./types";

export type { AgentRunLaunchSpec, AgentRuntimeBackendDriver } from "./types";

/**
 * Every Agent Runtime backend this deployment knows how to drive.
 *
 * Adding one — a VM per task, an agent-sandbox, a Dagger-hosted session — is a
 * new implementation of `AgentRuntimeBackendDriver` plus an entry here. Nothing in the A2A
 * task lifecycle, the routes or the UI changes.
 */
const BACKENDS: Record<AgentRuntimeBackendName, AgentRuntimeBackendDriver> = {
  kubernetes: kubernetesAgentRuntimeBackendDriver,
};

/**
 * The backend an Agent Runtime configuration uses.
 *
 * Refuses rather than falling back: silently running work somewhere other than
 * where the Agent says would make its environment and egress rules a lie.
 */
export function resolveAgentRuntimeBackendDriver(
  name: AgentRuntimeBackendName,
): AgentRuntimeBackendDriver {
  const backend = getAgentRuntimeBackendDriver(name);
  if (!backend.isEnabled) {
    throw new ApiError(
      503,
      `The "${name}" Agent Runtime backend is not available on this deployment, so this task cannot run`,
    );
  }
  return backend;
}

/** New launches must await discovery, rather than treating a cold cache as unavailable. */
export async function prepareAgentRuntimeBackendDriver(
  name: AgentRuntimeBackendName,
): Promise<AgentRuntimeBackendDriver> {
  const backend = getAgentRuntimeBackendDriver(name);
  await backend.assertReady();
  return backend;
}

/** Whether this installation has at least one usable Agent Runtime backend. */
export function isAnyAgentRuntimeBackendDriverEnabled(): boolean {
  return Object.values(BACKENDS).some((backend) => backend.isEnabled);
}

function getAgentRuntimeBackendDriver(
  name: AgentRuntimeBackendName,
): AgentRuntimeBackendDriver {
  const backend = BACKENDS[name];
  if (!backend) {
    throw new ApiError(400, `Unknown Agent Runtime backend "${name}"`);
  }
  return backend;
}
