import { isDeepStrictEqual } from "node:util";
import type { FastifyInstance } from "fastify";
import { userHasPermission } from "@/auth/utils";
import type { LocalConfig } from "@/types";
import { ApiError } from "@/types";

/**
 * A self-hosted MCP server's custom deployment YAML sets its whole pod spec —
 * service account, security context, volumes — so writing it needs
 * `mcpAdvancedSettings:update` on top of the registry permission that gates
 * the rest of the catalog item.
 *
 * @param params.current - The stored YAML. When the requested value matches it,
 *   nothing changes and no permission is needed.
 */
export async function assertCanWriteMcpDeploymentYaml(params: {
  userId: string;
  organizationId: string;
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

  const allowed = await userHasPermission(
    params.userId,
    params.organizationId,
    "mcpAdvancedSettings",
    "update",
  );
  if (!allowed) {
    throw new ApiError(
      403,
      "Changing Kubernetes deployment YAML, Secret/ConfigMap references, or the service account requires the mcpAdvancedSettings:update permission.",
    );
  }
}

/** Redact stored YAML everywhere it occurs in an authenticated API response,
 * including nested installed-server catalogs and audit snapshots. */
export function registerMcpDeploymentYamlResponseFilter(
  app: FastifyInstance,
): void {
  app.addHook("preSerialization", async (request, _reply, payload) => {
    if (!containsDeploymentYaml(payload)) return payload;
    const allowed =
      request.user &&
      request.organizationId &&
      (await userHasPermission(
        request.user.id,
        request.organizationId,
        "mcpAdvancedSettings",
        "read",
      ));
    return allowed ? payload : redactDeploymentYaml(payload);
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

function redactDeploymentYaml(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactDeploymentYaml);
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "deploymentSpecYaml" ? null : redactDeploymentYaml(child),
    ]),
  );
}
