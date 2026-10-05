import type { Permissions } from "@archestra/shared";
import { getPermissionsForUserContext } from "@/auth/utils";
import AgentModel from "@/models/agent";
import ResourcePermissionSubjectModel, {
  type GrantPrincipal,
} from "@/models/resource-permission-subject";
import type { GatewayAgent } from "@/types";

/**
 * Caller and agent lookups for ONE request, each made at most once.
 *
 * A request builds one and passes it down explicitly. It is never stored or
 * shared across requests, so every request still reads fresh grants, roles
 * and agent configuration.
 */
export class RequestLookups {
  private principals = new Map<string, Promise<GrantPrincipal>>();
  private permissionSets = new Map<string, Promise<Permissions>>();
  private agents = new Map<string, Promise<GatewayAgent | null>>();

  /** {@link ResourcePermissionSubjectModel.resolvePrincipal}, memoized. */
  principal(params: {
    userId: string;
    organizationId: string;
  }): Promise<GrantPrincipal> {
    return memoize(this.principals, callerKey(params), () =>
      ResourcePermissionSubjectModel.resolvePrincipal(params),
    );
  }

  /** {@link getPermissionsForUserContext}, memoized. */
  permissions(params: {
    userId: string;
    organizationId: string;
  }): Promise<Permissions> {
    return memoize(this.permissionSets, callerKey(params), () =>
      getPermissionsForUserContext(params),
    );
  }

  /** {@link AgentModel.findGatewayAgentById}, memoized. */
  gatewayAgent(agentId: string): Promise<GatewayAgent | null> {
    return memoize(this.agents, agentId, () =>
      AgentModel.findGatewayAgentById(agentId),
    );
  }

  /** {@link AgentModel.findEnvironmentId} from the memoized row. */
  async agentEnvironmentId(agentId: string): Promise<string | null> {
    return (await this.gatewayAgent(agentId))?.environmentId ?? null;
  }

  /** {@link AgentModel.getAccessAllTools} from the memoized row. */
  async agentAccessAllTools(agentId: string): Promise<boolean> {
    return (await this.gatewayAgent(agentId))?.accessAllTools ?? false;
  }

  /** {@link AgentModel.getAccessAllSubagents} from the memoized row. */
  async agentAccessAllSubagents(agentId: string): Promise<boolean> {
    return (await this.gatewayAgent(agentId))?.accessAllSubagents ?? false;
  }
}

function callerKey(params: { userId: string; organizationId: string }) {
  return `${params.organizationId}\u0000${params.userId}`;
}

function memoize<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached;
  const loaded = load();
  cache.set(key, loaded);
  return loaded;
}
