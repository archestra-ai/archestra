import { isDeepStrictEqual } from "node:util";
import { hasScopedPermission } from "@archestra/shared";
import type { FastifyInstance } from "fastify";
import { ResourcePermissions } from "@/services/resource-permissions";
import type { LocalConfig } from "@/types";
import { ApiError } from "@/types";

export async function assertCanManageMcpDeployment(params: {
  userId: string;
  organizationId: string;
  catalogId?: string;
}): Promise<void> {
  if (!(await canManageMcpDeployment(params)))
    throw new ApiError(
      403,
      "Deployment settings require the configure-deployment-spec permission on this MCP registry entry.",
    );
}

export async function assertCanWriteMcpDeploymentYaml(params: {
  userId: string;
  organizationId: string;
  catalogId?: string;
  requested: string | null | undefined;
  current?: string | null;
  requestedLocalConfig?: Pick<LocalConfig, "envFrom" | "serviceAccount"> | null;
  currentLocalConfig?: Pick<LocalConfig, "envFrom" | "serviceAccount"> | null;
}): Promise<void> {
  const yamlChanged =
    params.requested !== undefined &&
    (params.requested || null) !== (params.current || null);
  const localConfig = params.requestedLocalConfig;
  const envFromChanged =
    localConfig !== undefined &&
    !isDeepStrictEqual(
      localConfig?.envFrom ?? [],
      params.currentLocalConfig?.envFrom ?? [],
    );
  const serviceAccountChanged =
    localConfig !== undefined &&
    (localConfig?.serviceAccount?.trim() || "default") !==
      (params.currentLocalConfig?.serviceAccount?.trim() || "default");
  if (!yamlChanged && !envFromChanged && !serviceAccountChanged) return;

  await assertCanManageMcpDeployment(params);
}

/** Redact stored YAML everywhere it occurs in an authenticated API response,
 * including nested installed-server catalogs and audit snapshots. */
export function registerMcpDeploymentYamlResponseFilter(
  app: FastifyInstance,
): void {
  app.addHook("preSerialization", async (request, _reply, payload) => {
    if (!containsDeploymentYaml(payload)) return payload;
    const context =
      request.user && request.organizationId
        ? { userId: request.user.id, organizationId: request.organizationId }
        : null;
    const permissions = new Map<string, Promise<boolean>>();
    const filter = async (value: unknown): Promise<unknown> => {
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value)) return Promise.all(value.map(filter));
      if (Object.getPrototypeOf(value) !== Object.prototype) return value;
      const object = value as Record<string, unknown>;
      const catalogId = typeof object.id === "string" ? object.id : undefined;
      let allowed = false;
      if (object.deploymentSpecYaml != null && context) {
        const scope = catalogId ?? "*";
        if (!permissions.has(scope))
          permissions.set(
            scope,
            canManageMcpDeployment({ ...context, catalogId }),
          );
        allowed = (await permissions.get(scope)) ?? false;
      }
      return Object.fromEntries(
        await Promise.all(
          Object.entries(object).map(async ([key, child]) => [
            key,
            key === "deploymentSpecYaml" && !allowed
              ? null
              : await filter(child),
          ]),
        ),
      );
    };
    return filter(payload);
  });
}

/**
 * Deployment settings reach the cluster the server runs on, so they need their
 * own `configure-deployment-spec` action on the entry (or on `*`). Full access
 * does not imply it: a creator's automatic grant stops short of it.
 */
async function canManageMcpDeployment(params: {
  userId: string;
  organizationId: string;
  catalogId?: string;
}): Promise<boolean> {
  const context = {
    userId: params.userId,
    organizationId: params.organizationId,
    resource: "mcpRegistry" as const,
    scope: params.catalogId ?? "*",
  };
  const grants = await ResourcePermissions.resolve(context);
  return hasScopedPermission({
    grants,
    required: { ...context, action: "configure-deployment-spec" },
  });
}

function containsDeploymentYaml(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsDeploymentYaml);
  return Object.entries(value).some(
    ([key, child]) =>
      (key === "deploymentSpecYaml" && child != null) ||
      containsDeploymentYaml(child),
  );
}
