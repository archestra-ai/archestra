import { userHasPermission } from "@/auth";
import config from "@/config";
import AgentModel from "@/models/agent";
import ConnectionSetupModel from "@/models/connection-setup";
import MemberModel from "@/models/member";
import { ApiError, GATEWAY_CAPABLE_AGENT_TYPES } from "@/types";
import { verifyConnectionRuntimeToken } from "./connection-runtime-token";
import { ResourcePermissions } from "./resource-permissions";

/** Shared by artifact delivery and client binding provenance; checks live grants. */
export async function authenticateConnectionRuntime(token: string) {
  const setupId = verifyConnectionRuntimeToken({
    token,
    secret: config.auth.secret ?? "",
  });
  if (!setupId) throw new ApiError(401, "Invalid runtime update credential");
  const setup = await ConnectionSetupModel.findById(setupId);
  if (
    !setup?.consumedAt ||
    setup.revokedAt ||
    !["opencode", "kilo"].includes(setup.clientId)
  ) {
    throw new ApiError(403, "Installed connection is no longer available");
  }
  const members = await MemberModel.findByUserIdsInOrganization({
    organizationId: setup.organizationId,
    userIds: [setup.userId],
  });
  if (!members.length)
    throw new ApiError(403, "Installed connection is no longer available");
  if (setup.mcpGatewayId) {
    const canUse = await ResourcePermissions.allows({
      userId: setup.userId,
      organizationId: setup.organizationId,
      resource: "mcpGateway",
      scope: setup.mcpGatewayId,
      action: "use",
    });
    const gateway = canUse
      ? await AgentModel.findById(setup.mcpGatewayId)
      : null;
    if (
      !gateway ||
      gateway.organizationId !== setup.organizationId ||
      !GATEWAY_CAPABLE_AGENT_TYPES.some((type) => type === gateway.agentType)
    ) {
      throw new ApiError(403, "Installed connection is no longer available");
    }
  }
  if (setup.llmProxyId) {
    const canRead = await userHasPermission(
      setup.userId,
      setup.organizationId,
      "llmProxy",
      "read",
    );
    const proxy = canRead ? await AgentModel.findById(setup.llmProxyId) : null;
    if (
      !proxy ||
      proxy.organizationId !== setup.organizationId ||
      proxy.agentType !== "llm_proxy"
    )
      throw new ApiError(403, "Installed connection is no longer available");
  }
  return {
    setupId,
    organizationId: setup.organizationId,
    userId: setup.userId,
    clientId: setup.clientId as "opencode" | "kilo",
    mcpGatewayId: setup.mcpGatewayId,
    llmProxyId: setup.llmProxyId,
  };
}
