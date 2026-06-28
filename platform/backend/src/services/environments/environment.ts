import { daggerEnvironmentRuntimeManager } from "@/k8s/dagger-environment-runtime/manager";
import logger from "@/logging";
import { EnvironmentModel, OrganizationModel } from "@/models";
import {
  ApiError,
  type CreateEnvironment,
  type Environment,
  type EnvironmentList,
  type InternalMcpCatalogServerType,
  type UpdateEnvironment,
} from "@/types";
import { validateValuesAgainstRegex } from "@/utils/validate-values-against-regex";
import { evaluateRemoteServerUrlAgainstNetworkPolicy } from "./remote-server-network-policy";

/**
 * Provision (or update) the environment's per-env Dagger engine + egress
 * NetworkPolicy in the background. Fire-and-forget: a k8s hiccup must not fail
 * environment CRUD, and the manager no-ops when code-runtime/k8s is off.
 */
function reconcileEnvironmentEngine(environment: Environment): void {
  void daggerEnvironmentRuntimeManager
    .reconcileEnvironment(environment)
    .catch((err) =>
      logger.error(
        { err, environmentId: environment.id },
        "[DaggerEnvRuntime] background reconcile failed",
      ),
    );
}

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
  const created = await EnvironmentModel.create({
    organizationId,
    name: data.name,
    description: data.description ?? null,
    namespace: data.namespace ?? null,
    networkPolicy: data.networkPolicy ?? null,
    restricted: data.restricted,
    validationRegex: data.validationRegex ?? null,
  });
  reconcileEnvironmentEngine(created);
  return created;
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
    validationRegex: data.validationRegex,
  });
  if (!updated) {
    throw new ApiError(404, "Environment not found");
  }
  reconcileEnvironmentEngine(updated);
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

/**
 * Enforce a catalog item's governing environment regex against one or more sets
 * of user-supplied config values. No-op when the resolved regex is null. Throws
 * `ApiError(400)` (without echoing the pattern) on the first mismatch.
 */
export async function assertValuesMatchEnvironmentRegex(params: {
  environmentId: string | null | undefined;
  organizationId: string;
  valueSets: Array<Record<string, unknown> | null | undefined>;
}): Promise<void> {
  const { environmentId, organizationId, valueSets } = params;

  const { regex, label } = await resolveEnvironmentValidationRegex({
    environmentId,
    organizationId,
  });
  if (!regex) return;

  try {
    for (const values of valueSets) {
      validateValuesAgainstRegex(values, regex, label);
    }
  } catch (e) {
    throw new ApiError(400, (e as Error).message);
  }
}

/**
 * Enforce that a remote MCP server's URL is reachable under its governing
 * environment's network egress policy. No-op for self-hosted servers (their
 * egress is enforced by the real k8s NetworkPolicy on the pod) and for
 * unrestricted / built-in policies. Throws `ApiError(400)` when the policy
 * would block the backend's outbound connection to the server URL.
 *
 * This is the create/edit-time guard, for early feedback in the form. The
 * runtime connection guard in the MCP client enforces the same policy on actual
 * calls, so a grandfathered server is still blocked at call time.
 */
export async function assertRemoteServerUrlAllowedByNetworkPolicy(params: {
  serverType: InternalMcpCatalogServerType;
  serverUrl: string | null | undefined;
  environmentId: string | null | undefined;
  organizationId: string;
}): Promise<void> {
  const verdict = await evaluateRemoteServerUrlAgainstNetworkPolicy(params);
  if (!verdict.allowed) {
    // internal_code lets the frontend attach this to the Server URL field
    // inline instead of a generic toast. Keep in sync with the frontend
    // constant of the same value.
    throw new ApiError(400, verdict.message, "remote_server_url_not_allowed");
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

// === Internal helpers ===

/**
 * Resolve the allowlist validation regex governing a catalog item, plus the
 * human-readable label to name in errors. A set `environmentId` resolves to
 * that environment's rule; a null/undefined one falls back to the org's default
 * environment (`defaultEnvironmentValidationRegex`), mirroring how
 * `assertCanAssignEnvironment` treats the implicit default.
 */
async function resolveEnvironmentValidationRegex(params: {
  environmentId: string | null | undefined;
  organizationId: string;
}): Promise<{ regex: string | null; label: string }> {
  const { environmentId, organizationId } = params;

  if (!environmentId) {
    const organization = await OrganizationModel.getById(organizationId);
    return {
      regex: organization?.defaultEnvironmentValidationRegex ?? null,
      label: organization?.defaultEnvironmentName ?? "Default",
    };
  }

  const environment = await EnvironmentModel.findByIdForOrganization(
    environmentId,
    organizationId,
  );
  return {
    regex: environment?.validationRegex ?? null,
    label: environment?.name ?? "Default",
  };
}
