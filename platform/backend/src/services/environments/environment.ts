import { EnvironmentModel, OrganizationModel } from "@/models";
import {
  ApiError,
  type CreateEnvironment,
  type Environment,
  type EnvironmentWithAssignedCount,
  type UpdateEnvironment,
} from "@/types";

// === Public API ===

export async function listEnvironments(
  organizationId: string,
): Promise<EnvironmentWithAssignedCount[]> {
  return EnvironmentModel.listForOrganization(organizationId);
}

export async function createEnvironment(params: {
  organizationId: string;
  data: CreateEnvironment;
}): Promise<Environment> {
  const { organizationId, data } = params;
  const existing = await EnvironmentModel.listForOrganization(organizationId);
  if (existing.some((e) => e.name === data.name)) {
    throw new ApiError(409, "An environment with this name already exists.");
  }
  return EnvironmentModel.create({
    organizationId,
    name: data.name,
    description: data.description ?? null,
    namespace: data.namespace ?? null,
    restricted: data.restricted,
  });
}

export async function updateEnvironment(params: {
  id: string;
  organizationId: string;
  data: UpdateEnvironment;
}): Promise<Environment> {
  const { id, organizationId, data } = params;
  const updated = await EnvironmentModel.update({
    id,
    organizationId,
    description: data.description,
    namespace: data.namespace,
    restricted: data.restricted,
  });
  if (!updated) {
    throw new ApiError(404, "Environment not found");
  }
  return updated;
}

/**
 * Gate assigning a catalog item to an environment. Unrestricted environments
 * are open; a `restricted` environment requires the caller to hold
 * `environment:admin`. The default (null) environment is open unless the org
 * has marked its default environment restricted, in which case it is gated the
 * same way. Callers compute `hasEnvironmentAdmin` with their own auth primitive
 * (route headers vs. MCP user context) and pass the result in, so this stays
 * free of HTTP concerns.
 */
export async function assertCanAssignEnvironment(params: {
  environmentId: string | null | undefined;
  organizationId: string;
  hasEnvironmentAdmin: boolean;
}): Promise<void> {
  const { environmentId, organizationId, hasEnvironmentAdmin } = params;

  if (!environmentId) {
    const organization = await OrganizationModel.getById(organizationId);
    if (organization?.defaultEnvironmentRestricted && !hasEnvironmentAdmin) {
      throw new ApiError(
        403,
        "You do not have permission to assign catalog items to the default environment.",
      );
    }
    return;
  }

  const environment = await EnvironmentModel.findByIdForOrganization(
    environmentId,
    organizationId,
  );
  if (!environment) {
    throw new ApiError(404, "Environment not found");
  }
  if (environment.restricted && !hasEnvironmentAdmin) {
    throw new ApiError(
      403,
      "You do not have permission to assign catalog items to this restricted environment.",
    );
  }
}

export async function deleteEnvironment(params: {
  id: string;
  organizationId: string;
}): Promise<void> {
  const deleted = await EnvironmentModel.delete(
    params.id,
    params.organizationId,
  );
  if (!deleted) {
    throw new ApiError(404, "Environment not found");
  }
}
