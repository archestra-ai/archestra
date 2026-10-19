import { createHash } from "node:crypto";
import {
  DEFAULT_APP_NAME,
  resolveRuntimeHandoffInstructions,
  TOOL_LIST_AGENTS_SHORT_NAME,
  TOOL_START_RUN_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { isArchestraToolAvailableToAgent } from "@/archestra-mcp-server/dynamic-tools";
import { filterToolNamesByPermission } from "@/archestra-mcp-server/rbac";
import { userHasPermission } from "@/auth";
import config from "@/config";
import {
  AgentModel,
  ConnectionSetupModel,
  MemberModel,
  OrganizationModel,
} from "@/models";
import {
  ApiError,
  GATEWAY_CAPABLE_AGENT_TYPES,
  type Organization,
} from "@/types";
import { verifyConnectionInstructionsToken } from "./connection-instructions-token";
import { ResourcePermissions } from "./resource-permissions";

/** Authenticate the installation and recheck live membership and gateway access. */
export async function getConnectionManagedInstructions(token: string) {
  const setupId = verifyConnectionInstructionsToken({
    token,
    secret: config.auth.secret ?? "",
  });
  if (!setupId) throw new ApiError(401, "Invalid instruction credential");
  const setup = await ConnectionSetupModel.findById(setupId);
  if (!setup?.consumedAt || !setup.mcpGatewayId)
    throw new ApiError(403, "Connection is no longer available");
  const members = await MemberModel.findByUserIdsInOrganization({
    organizationId: setup.organizationId,
    userIds: [setup.userId],
  });
  if (members.length === 0)
    throw new ApiError(403, "Connection is no longer available");
  const [canRead, isAdmin] = await Promise.all([
    userHasPermission(setup.userId, setup.organizationId, "mcpGateway", "read"),
    ResourcePermissions.allows({
      userId: setup.userId,
      organizationId: setup.organizationId,
      resource: "mcpGateway",
      scope: "*",
      action: "update",
    }),
  ]);
  const gateway =
    canRead || isAdmin
      ? await AgentModel.findById(setup.mcpGatewayId, setup.userId, isAdmin)
      : null;
  if (
    !gateway ||
    gateway.organizationId !== setup.organizationId ||
    !GATEWAY_CAPABLE_AGENT_TYPES.some((type) => type === gateway.agentType)
  )
    throw new ApiError(403, "Connection is no longer available");
  const organization = await OrganizationModel.getById(setup.organizationId);
  if (!organization)
    throw new ApiError(403, "Connection is no longer available");
  const instructions = await resolveConnectionRuntimeHandoffInstructions({
    organization,
    gatewayId: gateway.id,
    userId: setup.userId,
  });
  return {
    instructions,
    version: createHash("sha256")
      .update(JSON.stringify(instructions))
      .digest("hex"),
  };
}

/**
 * The cloud-runtime handoff hint for a connected client, or null. The hint
 * tells the person they can move the session to Agent Runtime, so it is only
 * given when the gateway lets them: they may start runs, and the gateway can
 * reach the tools a handoff needs, listed or through run_tool.
 */
export async function resolveConnectionRuntimeHandoffInstructions(params: {
  organization: Pick<
    Organization,
    | "id"
    | "appName"
    | "connectionRuntimeHandoffEnabled"
    | "connectionRuntimeHandoffInstructions"
  >;
  gatewayId: string;
  userId: string;
}): Promise<string | null> {
  const { organization, gatewayId, userId } = params;
  if (!organization.connectionRuntimeHandoffEnabled) return null;
  const toolNames = RUNTIME_HANDOFF_TOOL_SHORT_NAMES.map((shortName) =>
    archestraMcpBranding.getToolName(shortName),
  );
  const permitted = await filterToolNamesByPermission(
    toolNames,
    userId,
    organization.id,
  );
  for (const toolName of toolNames) {
    if (!permitted.has(toolName)) return null;
    const reachable = await isArchestraToolAvailableToAgent({
      toolName,
      agentId: gatewayId,
      userId,
      organizationId: organization.id,
    });
    if (!reachable) return null;
  }
  return resolveRuntimeHandoffInstructions({
    stored: organization.connectionRuntimeHandoffInstructions,
    appName: organization.appName ?? DEFAULT_APP_NAME,
  });
}

// A handoff picks the target agent, then starts a run on it.
const RUNTIME_HANDOFF_TOOL_SHORT_NAMES = [
  TOOL_LIST_AGENTS_SHORT_NAME,
  TOOL_START_RUN_SHORT_NAME,
] as const;
