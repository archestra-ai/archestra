import { EnvironmentModel, OrganizationModel } from "@/models";
import {
  ApiError,
  type CreateEnvironment,
  type Environment,
  type EnvironmentList,
  type UpdateEnvironment,
} from "@/types";

// === Public API ===

export async function listEnvironments(
  organizationId: string,
): Promise<EnvironmentList> {
  const [environments, defaultAssignedCatalogCount] = await Promise.all([
    EnvironmentModel.listForOrganization(organizationId),
    EnvironmentModel.countDefaultAssigned(organizationId),
  ]);
  return { environments, defaultAssignedCatalogCount };
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
    networkPolicy: data.networkPolicy ?? null,
    restricted: data.restricted,
  });
}

export async function updateEnvironment(params: {
  id: string;
  organizationId: string;
  data: UpdateEnvironment;
}): Promise<Environment> {
  const { id, organizationId, data } = params;

  if (data.name !== undefined) {
    const existing = await EnvironmentModel.listForOrganization(organizationId);
    if (existing.some((e) => e.id !== id && e.name === data.name)) {
      throw new ApiError(409, "An environment with this name already exists.");
    }
  }
  const updated = await EnvironmentModel.update({
    id,
    organizationId,
    name: data.name,
    description: data.description,
    namespace: data.namespace,
    networkPolicy: data.networkPolicy,
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
 * `environment:deploy-to-restricted` (or `environment:admin`, which implies it).
 * The default (null) environment is open unless the org has marked its default
 * environment restricted, in which case it is gated the same way. Callers
 * compute `canDeployToRestricted` with their own auth primitive (route headers
 * vs. MCP user context) and pass the result in, so this stays free of HTTP
 * concerns.
 */
export async function assertCanAssignEnvironment(params: {
  environmentId: string | null | undefined;
  organizationId: string;
  canDeployToRestricted: boolean;
}): Promise<void> {
  const { environmentId, organizationId, canDeployToRestricted } = params;

  if (!environmentId) {
    const organization = await OrganizationModel.getById(organizationId);
    if (organization?.defaultEnvironmentRestricted && !canDeployToRestricted) {
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
  if (environment.restricted && !canDeployToRestricted) {
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
  const { id, organizationId } = params;

  const environment = await EnvironmentModel.findByIdForOrganization(
    id,
    organizationId,
  );
  if (!environment) {
    throw new ApiError(404, "Environment not found");
  }

  const assignedCount = await EnvironmentModel.countAssignedCatalogItems(id);
  if (assignedCount > 0) {
    throw new ApiError(
      409,
      `This environment still has ${assignedCount} catalog item${
        assignedCount === 1 ? "" : "s"
      } assigned. Reassign or remove them before deleting it.`,
    );
  }

  const deleted = await EnvironmentModel.delete(id, organizationId);
  if (!deleted) {
    throw new ApiError(404, "Environment not found");
  }
}
