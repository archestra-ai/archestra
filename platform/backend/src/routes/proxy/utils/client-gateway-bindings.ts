import { authenticateConnectionRuntime } from "@/services/connection-runtime";
import type { ClientRuntimeEvidence } from "./client-runtime-evidence";
import type { GatewayClientBindings } from "./gateway-tool-names";

/** The installed runtime endorses its registry separately from copyable tool markers. */
export async function resolveClientGatewayBindings(params: {
  evidence: ClientRuntimeEvidence | undefined;
  organizationId: string;
  llmProxyId?: string;
}): Promise<GatewayClientBindings | undefined> {
  if (!params.evidence) return undefined;
  try {
    const installation = await authenticateConnectionRuntime(
      params.evidence.token,
    );
    if (
      installation.organizationId !== params.organizationId ||
      !installation.mcpGatewayId ||
      (installation.llmProxyId !== null &&
        installation.llmProxyId !== params.llmProxyId)
    )
      return undefined;
    return {
      gatewayId: installation.mcpGatewayId,
      serverNames: params.evidence.serverNames,
    };
  } catch {
    // Revocation, invalid credentials, and transient lookup failures never
    // relax replay protection. Keep ordinary single-registration behavior.
    return undefined;
  }
}
