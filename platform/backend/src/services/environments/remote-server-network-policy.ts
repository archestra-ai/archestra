import { EnvironmentModel, OrganizationModel } from "@/models";
import type { InternalMcpCatalogServerType, NetworkPolicy } from "@/types";
import { isHostAllowedByNetworkPolicy } from "./network-policy-match";

// === Public API ===

type RemoteServerNetworkPolicyVerdict =
  | { allowed: true }
  | { allowed: false; message: string };

/**
 * Decide whether a remote MCP server's URL is reachable under its governing
 * environment's network egress policy. Non-throwing — returns a verdict plus a
 * human-readable message so both the write-time guard (which raises a 400) and
 * the runtime connection guard (which fails the MCP call) can share one source
 * of truth.
 *
 * Always allows non-remote servers (self-hosted egress is enforced by the real
 * k8s NetworkPolicy on the pod) and `unrestricted` / built-in policies.
 */
export async function evaluateRemoteServerUrlAgainstNetworkPolicy(params: {
  serverType: InternalMcpCatalogServerType;
  serverUrl: string | null | undefined;
  environmentId: string | null | undefined;
  organizationId: string;
}): Promise<RemoteServerNetworkPolicyVerdict> {
  const { serverType, serverUrl, environmentId, organizationId } = params;
  if (serverType !== "remote" || !serverUrl) return { allowed: true };

  const { policy, label } = await resolveEnvironmentNetworkPolicy({
    environmentId,
    organizationId,
  });
  if (!policy || policy.egressMode === "unrestricted") return { allowed: true };

  let host: string;
  try {
    host = new URL(serverUrl).hostname;
  } catch {
    return { allowed: false, message: "Remote server URL is not a valid URL." };
  }

  if (isHostAllowedByNetworkPolicy({ host, policy })) return { allowed: true };

  return {
    allowed: false,
    message:
      policy.egressMode === "off"
        ? `The "${label}" environment blocks all outbound internet egress, so it cannot reach the remote MCP server at "${host}". Assign this server to an environment whose network policy permits egress.`
        : `The remote MCP server host "${host}" is not permitted by the "${label}" environment's network egress policy. Add it to the environment's allowed domains or CIDRs, or relax the policy.`,
  };
}

// === Internal helpers ===

/**
 * Resolve the effective network egress policy governing a catalog item, plus a
 * human-readable environment label for messages. A set `environmentId` resolves
 * to that environment's policy (falling back to the org default); a
 * null/undefined one resolves the org default environment's policy.
 */
async function resolveEnvironmentNetworkPolicy(params: {
  environmentId: string | null | undefined;
  organizationId: string;
}): Promise<{ policy: NetworkPolicy | null; label: string }> {
  const { environmentId, organizationId } = params;
  const organization = await OrganizationModel.getById(organizationId);

  if (!environmentId) {
    return {
      policy: organization?.defaultNetworkPolicy ?? null,
      label: organization?.defaultEnvironmentName ?? "Default",
    };
  }

  const environment = await EnvironmentModel.findByIdForOrganization(
    environmentId,
    organizationId,
  );
  return {
    policy:
      environment?.networkPolicy ?? organization?.defaultNetworkPolicy ?? null,
    label: environment?.name ?? "Default",
  };
}
