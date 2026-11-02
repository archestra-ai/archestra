import { userHasPermission } from "@/auth";
import { agentRuntimeManager } from "@/k8s/agent-runtime";
import { agentWarmPoolManager } from "@/k8s/agent-runtime/warm-pool";
import { daggerEnvironmentRuntimeManager } from "@/k8s/dagger-environment-runtime/manager";
import logger from "@/logging";
import { ApiError, type NetworkPolicy } from "@/types";
import { trackBackgroundWork } from "@/utils/background-work";

// === Public API ===

/**
 * An agent's own policy replaces its environment's, so it can loosen what an
 * environment administrator locked down. Writing one therefore takes the same
 * permission as editing an environment's network policy.
 */
export async function assertCanWriteAgentNetworkPolicy(params: {
  userId: string;
  organizationId: string;
  before: NetworkPolicy | null | undefined;
  after: NetworkPolicy | null | undefined;
}): Promise<void> {
  if (params.after === undefined) return;
  if (sameNetworkPolicy(params.before ?? null, params.after)) return;
  if (
    !(await userHasPermission(
      params.userId,
      params.organizationId,
      "environment",
      "update",
    ))
  ) {
    throw new ApiError(
      403,
      "Setting an agent's own network policy requires permission to update environments.",
    );
  }
}

/**
 * Whether an agent write changes the egress its own runtimes run under: its own
 * network policy, or the environment binding it inherits from (which also
 * decides where its Code Sandbox engine lives).
 */
export function agentNetworkRuntimeChanged(params: {
  before: AgentNetworkFields | null;
  after: AgentNetworkFields | null;
}): boolean {
  const { before, after } = params;
  return (
    !sameNetworkPolicy(
      before?.networkPolicy ?? null,
      after?.networkPolicy ?? null,
    ) || (before?.environmentId ?? null) !== (after?.environmentId ?? null)
  );
}

/**
 * Converge an agent's own runtimes on its current row after its network policy
 * or environment changed, or it was deleted: its Code Sandbox engine, the
 * egress of its running Agent Runtime workspaces, and the warm pools. In the
 * background — a Kubernetes hiccup must not fail the agent write, and each
 * manager no-ops when its runtime is off.
 */
export function syncAgentNetworkRuntimes(params: {
  agentId: string;
  organizationId: string;
  /**
   * Whether the agent had or has its own policy, so an engine of its own may
   * need provisioning, moving or removing. Defaults to true.
   */
  engine?: boolean;
}): void {
  const { agentId, organizationId, engine = true } = params;
  trackBackgroundWork(
    (async () => {
      if (engine) {
        await daggerEnvironmentRuntimeManager
          .reconcileAgent(agentId)
          .catch((err) =>
            logger.error(
              { err, agentId },
              "[AgentNetworkPolicy] engine reconcile failed",
            ),
          );
      }
      await agentRuntimeManager
        .refreshAgentWorkspacesEgress({ agentId, organizationId })
        .catch((err) =>
          logger.error(
            { err, agentId },
            "[AgentNetworkPolicy] workspace egress refresh failed",
          ),
        );
      await agentWarmPoolManager
        .reconcile()
        .catch((err) =>
          logger.error(
            { err, agentId: params.agentId },
            "[AgentNetworkPolicy] warm pool reconcile failed",
          ),
        );
    })(),
  );
}

// === Internal helpers ===

// Field-wise: a policy read back from jsonb does not keep its key order.
export function sameNetworkPolicy(
  a: NetworkPolicy | null,
  b: NetworkPolicy | null,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.egressMode === b.egressMode &&
    a.domainPreset === b.domainPreset &&
    a.allowedDomains.join("\n") === b.allowedDomains.join("\n") &&
    a.allowedCidrs.join("\n") === b.allowedCidrs.join("\n")
  );
}

interface AgentNetworkFields {
  networkPolicy?: NetworkPolicy | null;
  environmentId: string | null;
}
