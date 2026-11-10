import { buildForbiddenErrorMessage } from "@archestra/shared/access-control";
import { userHasPermission } from "@/auth";
import config from "@/config";
import AutoRouterModel from "@/models/auto-router";
import { ApiError } from "@/types";

/**
 * Checks the auto routers a virtual key form adds, before it is saved.
 * Undefined leaves the key's routers as they are. With auto routing off, only
 * an empty list is accepted. Adding a router spends its tiers' keys, so it
 * takes the same permission as editing the router, and every router must be
 * the organization's.
 */
export async function assertCanGrantAutoRouters(params: {
  autoRouterIds: string[] | undefined;
  organizationId: string;
  userId: string;
}): Promise<void> {
  const { autoRouterIds } = params;
  if (autoRouterIds === undefined) return;
  if (!config.autoRouting.enabled) {
    if (autoRouterIds.length === 0) return;
    throw new ApiError(400, "Auto routing is not enabled");
  }
  const allowed = await userHasPermission(
    params.userId,
    params.organizationId,
    "llmProxy",
    "update",
  );
  if (!allowed) {
    throw new ApiError(
      403,
      buildForbiddenErrorMessage({
        missingPermissions: { llmProxy: ["update"] },
      }),
    );
  }
  if (autoRouterIds.length === 0) return;
  const routers = await AutoRouterModel.list(params.organizationId);
  const known = new Set(routers.map((router) => router.id));
  if (autoRouterIds.some((id) => !known.has(id))) {
    throw new ApiError(400, "Auto router not found");
  }
}
