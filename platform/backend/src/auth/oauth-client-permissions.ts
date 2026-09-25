// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  hasScopedPermission,
  type ResourcePermissionAction,
  type ScopedPermission,
} from "@archestra/shared";
import { ResourcePermissions } from "@/services/resource-permissions";
import { ApiError } from "@/types";

/**
 * Who may see and manage one OAuth client registration (MCP gateway or LLM
 * proxy kind). It is a question about the client's grants: its creator holds
 * full access, the built-in admin tiers hold it at `*`, and sharing with a
 * team, a role or the organization is one more grant on the client.
 *
 * Grants govern the management plane only. A token minted for the client is
 * checked against the client's own configuration, never against these grants.
 */
export async function requireOauthClientAccess(params: {
  organizationId: string;
  userId: string;
  resource: "llmOauthClient" | "mcpOauthClient";
  id: string;
  action: ResourcePermissionAction;
}): Promise<void> {
  const notFound =
    params.resource === "mcpOauthClient"
      ? "MCP OAuth client not found"
      : "LLM OAuth client not found";
  const context = {
    organizationId: params.organizationId,
    userId: params.userId,
    resource: params.resource,
    scope: params.id,
  };
  let grants: ScopedPermission[];
  try {
    ({ grants } = await ResourcePermissions.getEffective(context));
  } catch (error) {
    // A malformed id is simply an id that names no client.
    if (
      error instanceof ApiError &&
      (error.statusCode === 404 || error.statusCode === 400)
    )
      throw new ApiError(404, notFound);
    throw error;
  }
  const holds = (action: ResourcePermissionAction) =>
    hasScopedPermission({ grants, required: { ...context, action } });
  if (holds(params.action)) return;
  // A client the caller cannot even see answers exactly as a missing one
  // does: which of the two it is is itself not theirs to learn.
  if (!holds("read")) throw new ApiError(404, notFound);
  throw new ApiError(
    403,
    "You do not have permission to perform this action on this OAuth client",
  );
}
