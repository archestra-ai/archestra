import { buildForbiddenErrorMessage } from "@archestra/shared/access-control";
import { userHasPermission } from "@/auth";
import config from "@/config";
import { ModelPoolModel } from "@/models";
import { ApiError } from "@/types";

/**
 * Checks the model pools a virtual key or OAuth client form grants, before it
 * is saved. Undefined leaves the credential's pools as they are. With model
 * pools off, only an empty list is accepted. Granting a pool spends its
 * members' keys, so it takes the same permission as editing the pool, and
 * every pool must be the organization's.
 */
export async function assertCanGrantModelPools(params: {
  modelPoolIds: string[] | undefined;
  organizationId: string;
  userId: string;
}): Promise<void> {
  const { modelPoolIds } = params;
  if (modelPoolIds === undefined) return;
  if (!config.llmProxy.modelPoolsEnabled) {
    if (modelPoolIds.length === 0) return;
    throw new ApiError(400, "Model pools are not enabled");
  }
  const allowed = await userHasPermission(
    params.userId,
    params.organizationId,
    "llmModel",
    "update",
  );
  if (!allowed) {
    throw new ApiError(
      403,
      buildForbiddenErrorMessage({
        missingPermissions: { llmModel: ["update"] },
      }),
    );
  }
  if (modelPoolIds.length === 0) return;
  const pools = await ModelPoolModel.list(params.organizationId);
  const known = new Set(pools.map((pool) => pool.id));
  if (modelPoolIds.some((id) => !known.has(id))) {
    throw new ApiError(400, "Model pool not found");
  }
}
