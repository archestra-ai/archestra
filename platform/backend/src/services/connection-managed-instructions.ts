import { createHash } from "node:crypto";
import { DEFAULT_RUNTIME_HANDOFF_INSTRUCTIONS } from "@archestra/shared";
import { userHasPermission } from "@/auth";
import config from "@/config";
import {
  AgentModel,
  ConnectionSetupModel,
  MemberModel,
  OrganizationModel,
} from "@/models";
import { ApiError, GATEWAY_CAPABLE_AGENT_TYPES } from "@/types";
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
  const instructions = organization.connectionRuntimeHandoffEnabled
    ? (organization.connectionRuntimeHandoffInstructions ??
      DEFAULT_RUNTIME_HANDOFF_INSTRUCTIONS)
    : null;
  return {
    instructions,
    version: createHash("sha256")
      .update(JSON.stringify(instructions))
      .digest("hex"),
  };
}
